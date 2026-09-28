import {
  createPublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  fallback,
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
import { addressTopic, getLogs } from "../explorer";
import { mapLimit, tokenAsset } from "../tokens";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";

/**
 * Polygon PoS bridge: tokens burned on Polygon to withdraw to Ethereum, whose exit was
 * never processed on Ethereum.
 *
 *  1. Burns: ERC20 Transfer(user → 0x0) on Polygon, from the whole history.
 *  2. Only tokens mapped by the PoS bridge (RootChainManager.childToRootToken ≠ 0).
 *  3. Exit proof from Polygon's official proof generator.
 *  4. Status: simulate RootChainManager.exit(proof) on Ethereum.
 *     "EXIT_ALREADY_PROCESSED" → claimed; success → the funds are waiting.
 */

export const POLYGON: FindingSource = { id: "polygon", name: "Polygon PoS", guideId: "polygon-pos", explorer: "https://polygonscan.com" };

const ROOT_CHAIN_MANAGER: Address = "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77";
const TRANSFER = toEventSelector("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO_TOPIC = `0x${"0".repeat(64)}` as Hex;
const PROOF_API = "https://proof-generator.polygon.technology/api/v1/matic";

const POLYGON_TARGET = {
  name: "Polygon",
  chain: polygon,
  // Polygon's Blockscout index is incomplete, so it isn't used: a miss there would be silent.
  blockscout: undefined,
  logsRpcs: ["https://gateway.tenderly.co/public/polygon"],
};

const rcmAbi = parseAbi([
  "function childToRootToken(address) view returns (address)",
  "function exit(bytes inputData)",
]);

let polygonClient: ReturnType<typeof createPublicClient> | undefined;
const polygonRpc = () =>
  (polygonClient ??= createPublicClient({
    chain: polygon,
    transport: fallback([http("https://polygon-bor-rpc.publicnode.com"), http("https://gateway.tenderly.co/public/polygon")]),
  }));

type ExitState = { kind: "claimed" } | { kind: "ready" } | { kind: "waiting" } | { kind: "unknown"; why: string };

async function exitState(burnTx: Hex, from: Address): Promise<ExitState> {
  const res = await fetch(`${PROOF_API}/exit-payload/${burnTx}?eventSignature=${TRANSFER}`, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as { result?: Hex; message?: string; error?: boolean };
  if (!res.ok || !body.result) {
    const msg = body.message ?? `HTTP ${res.status}`;
    if (/checkpoint/i.test(msg)) return { kind: "waiting" };
    return { kind: "unknown", why: msg };
  }
  try {
    await l1Client().call({
      account: from,
      to: ROOT_CHAIN_MANAGER,
      data: encodeFunctionData({ abi: rcmAbi, functionName: "exit", args: [body.result] }),
    });
    return { kind: "ready" };
  } catch (e) {
    const text = JSON.stringify((e as { cause?: unknown }).cause ?? e) + String((e as Error).message);
    if (/EXIT_ALREADY_PROCESSED/.test(text)) return { kind: "claimed" };
    return { kind: "unknown", why: (e as { shortMessage?: string }).shortMessage ?? "simulation failed" };
  }
}

export async function checkPolygon(user: Address): Promise<CheckOutput> {
  // ERC20 burns by the user (3 topics; ERC721 transfers have 4).
  const logs = (await getLogs(POLYGON_TARGET, undefined, [TRANSFER, addressTopic(user), ZERO_TOPIC])).filter(
    (l) => l.topics.length === 3 && l.data.length === 66,
  );

  // Keep tokens mapped by the PoS bridge.
  const children = [...new Set(logs.map((l) => l.address.toLowerCase() as Address))];
  const roots = new Map<string, Address>();
  await Promise.all(
    children.map(async (c) => {
      const root = await l1Client()
        .readContract({ address: ROOT_CHAIN_MANAGER, abi: rcmAbi, functionName: "childToRootToken", args: [c] })
        .catch(() => zeroAddress);
      if (!isAddressEqual(root, zeroAddress)) roots.set(c, root);
    }),
  );
  const burns = logs.filter((l) => roots.has(l.address.toLowerCase()));

  const out: CheckOutput = { findings: [], completed: 0 };
  await mapLimit(burns, 3, async (l) => {
    const state = await exitState(l.transactionHash, user);
    if (state.kind === "claimed") {
      out.completed++;
      return;
    }
    const root = roots.get(l.address.toLowerCase())!;
    const [amount] = decodeAbiParameters([{ type: "uint256" }], l.data);
    out.findings.push(
      makeFinding(POLYGON, {
        key: l.transactionHash,
        label: "Polygon PoS → Ethereum",
        status: state.kind === "ready" ? "ready" : state.kind === "waiting" ? "recent" : "manual",
        asset: await tokenAsset([l1Client(), polygonRpc() as never], root, amount, "ethereum"),
        txHash: l.transactionHash,
        timestamp: l.timestamp,
        note:
          state.kind === "ready"
            ? "Burned on Polygon but never exited on Ethereum. Claim it in the Polygon Portal."
            : state.kind === "waiting"
              ? "Waiting for the next Polygon checkpoint on Ethereum (usually under 3 hours)."
              : `Couldn't confirm its status automatically (${state.why}). Check it in the Polygon Portal.`,
      }),
    );
  });
  return out;
}
