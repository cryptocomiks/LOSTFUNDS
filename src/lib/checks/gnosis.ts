import {
  concat,
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  fallback,
  hashMessage,
  hexToBigInt,
  hexToNumber,
  http,
  isAddressEqual,
  keccak256,
  numberToHex,
  parseAbi,
  parseAbiItem,
  recoverAddress,
  size,
  slice,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { gnosis } from "viem/chains";
import { l1Client } from "../clients";
import { evmClient } from "../evm";
import { mapLimit, tokenMeta } from "../tokens";
import type { Asset, WithdrawalStatus } from "../types";
import { DAY, makeFinding, now, type CheckOutput, type FindingSource } from "./common";
import { wouldSucceed } from "./simulate";

/**
 * Gnosis Chain → Ethereum transfers never claimed on Ethereum, through either bridge:
 *   - OmniBridge (tokens, over the AMB), found by sender
 *   - the xDAI bridge (xDAI → DAI / USDS), found by recipient
 *
 * Both work the same way: the bridge validators sign the transfer on Gnosis, then someone
 * submits the signatures to Ethereum (`executeSignatures`). Nothing happens automatically.
 * Whether it was claimed is read on Ethereum (`relayedMessages`), and whether it can be
 * claimed now is found by simulating the claim with the signatures stored on Gnosis.
 * Ethereum → Gnosis transfers are completed by the validators themselves.
 */

export const GNOSIS: FindingSource = { id: "gnosis", name: "Gnosis Bridge", guideId: "gnosis", explorer: "https://gnosisscan.io" };

/** Gnosis RPC nodes that answer event searches over the whole chain history (CORS-enabled, checked live). */
const LOGS_RPCS = ["https://rpc.gnosischain.com", "https://rpc.gnosis.gateway.fm"];

const OMNI = {
  /** HomeOmnibridge on Gnosis. */
  homeMediator: "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d" as Address,
  /** ForeignOmnibridge on Ethereum, the only executor of its messages. */
  foreignMediator: "0x88ad09518695c6c3712AC10a214bE5109a655671" as Address,
  homeAmb: "0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59" as Address,
  foreignAmb: "0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e" as Address,
};

const XDAI = {
  home: "0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6" as Address,
  foreign: "0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016" as Address,
  /**
   * The current withdrawal event (with a token field) starts at block 43,027,829. Earlier
   * withdrawals used other event formats; the ones never claimed were all signed by validators
   * who have been replaced since, so they can no longer be claimed.
   */
  fromBlock: 43_000_000n,
  tokens: {
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", priceKey: "coingecko:dai" },
    "0xdc035d45d973e3ec169d2276ddab16f1e407384f": { symbol: "USDS", priceKey: "coingecko:usds" },
  } as Record<string, { symbol: string; priceKey: string }>,
};

const TOKENS_BRIDGING_INITIATED = parseAbiItem(
  "event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)",
);
const AMB_REQUEST = parseAbiItem("event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)");
const XDAI_REQUEST = parseAbiItem("event UserRequestForSignature(address recipient, uint256 value, bytes32 nonce, address token)");

const bridgeAbi = parseAbi([
  // Ethereum side (ForeignAMB / xDAI ForeignBridge)
  "function relayedMessages(bytes32) view returns (bool)",
  "function executeSignatures(bytes message, bytes signatures)",
  "function validatorContract() view returns (address)",
  "function requiredSignatures() view returns (uint256)",
  "function isValidator(address) view returns (bool)",
  // Gnosis side (HomeAMB / xDAI HomeBridge), keyed by keccak256(message)
  "function numMessagesSigned(bytes32) view returns (uint256)",
  "function signature(bytes32, uint256) view returns (bytes)",
]);

/** The calls the Gnosis mediator sends to the Ethereum one. */
const mediatorAbi = parseAbi([
  "function handleNativeTokens(address token, address receiver, uint256 value)",
  "function handleNativeTokensAndCall(address token, address receiver, uint256 value, bytes data)",
  "function handleBridgedTokens(address token, address receiver, uint256 value)",
  "function handleBridgedTokensAndCall(address token, address receiver, uint256 value, bytes data)",
  "function deployAndHandleBridgedTokens(address token, string name, string symbol, uint8 decimals, address receiver, uint256 value)",
  "function deployAndHandleBridgedTokensAndCall(address token, string name, string symbol, uint8 decimals, address receiver, uint256 value, bytes data)",
]);

let logsClient: PublicClient | undefined;
function gnosisLogs(): PublicClient {
  logsClient ??= createPublicClient({
    chain: gnosis,
    transport: fallback(LOGS_RPCS.map((url) => http(url, { timeout: 30_000, retryCount: 2 }))),
  }) as PublicClient;
  return logsClient;
}

const gnosisClient = () => evmClient(gnosis.id)!;

async function blockTime(log: { blockNumber: bigint; blockTimestamp?: bigint | null }): Promise<number> {
  if (log.blockTimestamp) return Number(log.blockTimestamp);
  const block = (await gnosisClient().request({
    method: "eth_getBlockByNumber",
    params: [numberToHex(log.blockNumber), false],
  })) as { timestamp: Hex } | null;
  if (!block) throw new Error("Gnosis block not found");
  return hexToNumber(block.timestamp);
}

/** Signatures packed the way `executeSignatures` expects: [count][v…][r…][s…]. */
export function packSignatures(sigs: Hex[]): Hex {
  return concat([
    toHex(sigs.length, { size: 1 }),
    ...sigs.map((s) => slice(s, 64, 65)),
    ...sigs.map((s) => slice(s, 0, 32)),
    ...sigs.map((s) => slice(s, 32, 64)),
  ]);
}

type ClaimState =
  | "ready" // can be claimed now
  | "signing" // the validators haven't all signed yet
  | "stranded" // signed by validators who have since been replaced: Ethereum rejects it
  | "rejected"; // valid signatures, but Ethereum rejects the claim for another reason

/** Whether a Gnosis → Ethereum message can be claimed now, by simulating the claim on Ethereum. */
async function claimState(home: Address, foreign: Address, message: Hex, user: Address): Promise<ClaimState> {
  const gno = gnosisClient();
  const hash = keccak256(message);
  const raw = await gno.readContract({ address: home, abi: bridgeAbi, functionName: "numMessagesSigned", args: [hash] });
  const count = Number(raw & ((1n << 255n) - 1n));
  const finalized = raw >> 255n === 1n;
  if (!finalized || count === 0) return "signing";
  const sigs = await Promise.all(
    Array.from({ length: count }, (_, i) => gno.readContract({ address: home, abi: bridgeAbi, functionName: "signature", args: [hash, BigInt(i)] })),
  );
  const l1 = l1Client();
  const data = encodeFunctionData({ abi: bridgeAbi, functionName: "executeSignatures", args: [message, packSignatures(sigs)] });
  if (await wouldSucceed(l1, { from: user, to: foreign, data })) return "ready";

  // Why is it rejected? Usually the validators who signed it have been replaced since.
  const validators = await l1.readContract({ address: foreign, abi: bridgeAbi, functionName: "validatorContract" });
  const required = await l1.readContract({ address: validators, abi: bridgeAbi, functionName: "requiredSignatures" });
  const digest = hashMessage({ raw: message });
  const signers = await Promise.all(sigs.map((signature) => recoverAddress({ hash: digest, signature })));
  const current = await Promise.all(
    signers.map((a) => l1.readContract({ address: validators, abi: bridgeAbi, functionName: "isValidator", args: [a] })),
  );
  return BigInt(current.filter(Boolean).length) < required ? "stranded" : "rejected";
}

/** Parts of an AMB message (ArbitraryMessage.unpackData). */
export function parseAmbMessage(m: Hex) {
  if (size(m) < 79) return null;
  const srcLen = hexToNumber(slice(m, 76, 77));
  const dstLen = hexToNumber(slice(m, 77, 78));
  const start = 79 + srcLen + dstLen;
  if (dstLen === 0 || size(m) <= start) return null;
  return {
    messageId: slice(m, 0, 32),
    sender: slice(m, 32, 52),
    executor: slice(m, 52, 72),
    destinationChain: hexToBigInt(slice(m, 79 + srcLen, start)),
    data: slice(m, start),
  };
}

/** Receiver of an OmniBridge transfer, from the mediator call it carries. */
function receiverOf(data: Hex): Address | undefined {
  try {
    const { functionName, args } = decodeFunctionData({ abi: mediatorAbi, data });
    return (functionName.startsWith("deploy") ? args[4] : args[1]) as Address;
  } catch {
    return undefined;
  }
}

interface Pending {
  bridge: "OmniBridge" | "xDAI bridge";
  tx: Hex;
  key: Hex;
  timestamp: number;
  asset: Asset;
  state: ClaimState;
  receiver?: Address;
}

/** Keeps the messages not yet executed on Ethereum (one batched read), counting the others as completed. */
async function unclaimed<T>(items: T[], foreign: Address, id: (t: T) => Hex, out: CheckOutput): Promise<T[]> {
  const relayed = await Promise.all(
    items.map((t) => l1Client().readContract({ address: foreign, abi: bridgeAbi, functionName: "relayedMessages", args: [id(t)] })),
  );
  out.completed += relayed.filter(Boolean).length;
  return items.filter((_, i) => !relayed[i]);
}

async function omnibridge(user: Address, out: CheckOutput): Promise<Pending[]> {
  const logs = await gnosisLogs().getLogs({
    address: OMNI.homeMediator,
    event: TOKENS_BRIDGING_INITIATED,
    args: { sender: user },
    fromBlock: 0n,
    toBlock: "latest",
    strict: true,
  });
  const open = await unclaimed(logs, OMNI.foreignAmb, (l) => l.args.messageId, out);
  const pending = await mapLimit(open, 3, async (l): Promise<Pending | null> => {
    const { token, value, messageId } = l.args;
    // The message the validators signed, emitted by the AMB in the same transaction.
    const [req] = await gnosisClient().getLogs({
      address: OMNI.homeAmb,
      event: AMB_REQUEST,
      args: { messageId },
      fromBlock: l.blockNumber,
      toBlock: l.blockNumber,
      strict: true,
    });
    const message = req?.args.encodedData;
    const parsed = message && parseAmbMessage(message);
    if (!message || !parsed || parsed.messageId !== messageId || parsed.destinationChain !== 1n || !isAddressEqual(parsed.executor, OMNI.foreignMediator))
      return null;
    const meta = await tokenMeta([gnosisClient()], token);
    return {
      bridge: "OmniBridge",
      tx: l.transactionHash,
      key: messageId,
      timestamp: await blockTime(l),
      asset: { symbol: meta?.symbol ?? "tokens", decimals: meta?.decimals ?? 18, amount: value, priceKey: `xdai:${token.toLowerCase()}` },
      state: await claimState(OMNI.homeAmb, OMNI.foreignAmb, message, user),
      receiver: receiverOf(parsed.data),
    };
  });
  return pending.filter((p) => p !== null);
}

async function xdaiBridge(user: Address, out: CheckOutput): Promise<Pending[]> {
  // Nothing is indexed in this event: read every withdrawal and keep the user's.
  const logs = await gnosisLogs().getLogs({ address: XDAI.home, event: XDAI_REQUEST, fromBlock: XDAI.fromBlock, toBlock: "latest", strict: true });
  const mine = logs.filter((l) => isAddressEqual(l.args.recipient, user));
  const open = await unclaimed(mine, XDAI.foreign, (l) => l.args.nonce, out);
  return mapLimit(open, 3, async (l): Promise<Pending> => {
    const { recipient, value, nonce, token } = l.args;
    // What the validators signed (the ForeignBridge address guards against replays elsewhere).
    const message = encodePacked(["address", "uint256", "bytes32", "address", "address"], [recipient, value, nonce, XDAI.foreign, token]);
    const paid = XDAI.tokens[token.toLowerCase()] ?? { symbol: "xDAI", priceKey: "coingecko:xdai" };
    return {
      bridge: "xDAI bridge",
      tx: l.transactionHash,
      key: nonce,
      timestamp: await blockTime(l),
      asset: { symbol: paid.symbol, decimals: 18, amount: value, priceKey: paid.priceKey },
      state: await claimState(XDAI.home, XDAI.foreign, message, user),
    };
  });
}

const HELP = "Only the Gnosis bridge team can unblock it: reach them through the official Gnosis Chain docs (docs.gnosischain.com). Nobody legitimate will DM you first.";

export async function checkGnosisBridge(user: Address): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const pending = (await Promise.all([omnibridge(user, out), xdaiBridge(user, out)])).flat();
  for (const p of pending) {
    const age = now() - p.timestamp;
    let status: WithdrawalStatus;
    let note: string;
    if (p.state === "ready") {
      status = "ready";
      note =
        "Never claimed on Ethereum. Claim it soon in the Gnosis bridge app: once the bridge validators who signed it are replaced, it can no longer be claimed without help.";
    } else if (p.state === "signing") {
      if (age < DAY) {
        status = "recent";
        note = "The bridge validators are still signing it. It can be claimed on Ethereum once they're done, usually within minutes.";
      } else {
        status = "manual";
        note = `Never claimed on Ethereum, and the bridge validators never finished signing it. ${HELP}`;
      }
    } else if (p.state === "stranded") {
      status = "manual";
      note = `Never claimed on Ethereum, and the bridge validators who signed it have since been replaced, so Ethereum rejects the claim. ${HELP}`;
    } else {
      status = "manual";
      note = "Never claimed on Ethereum, but Ethereum rejects the claim right now (bridge limits or maintenance). Try again later in the Gnosis bridge app.";
    }
    if (p.receiver && !isAddressEqual(p.receiver, user)) note += ` The funds go to ${p.receiver}, the address chosen when it was sent.`;
    if (p.bridge === "xDAI bridge") note += ` Paid out as ${p.asset.symbol} on Ethereum.`;
    out.findings.push(
      makeFinding(GNOSIS, {
        key: p.key,
        label: `${p.bridge} · Gnosis → Ethereum`,
        status,
        asset: p.asset,
        txHash: p.tx,
        timestamp: p.timestamp,
        note,
      }),
    );
  }
  return out;
}
