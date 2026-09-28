import {
  decodeEventLog,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseAbi,
  toEventSelector,
  type Address,
  type Chain,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { getTimeToFinalize, getWithdrawalStatus, getWithdrawals } from "viem/op-stack";
import { l1Client, l2Client } from "../clients";
import { addressTopic, getLogs, uniqueTxs } from "../logs";
import { L1, type Network } from "../networks";
import { ethAsset, mapLimit, tokenAsset } from "../tokens";
import type { Asset, Finding } from "../types";
import { DAY, makeFinding, now, type CheckOutput } from "./common";

const abi = parseAbi([
  "event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)",
  "event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)",
  "event ERC20BridgeInitiated(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)",
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
  "event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)",
]);
const legacyMessengerAbi = parseAbi([
  "function relayMessage(address _target, address _sender, bytes _message, uint256 _messageNonce)",
  "function successfulMessages(bytes32) view returns (bool)",
]);

const T = {
  withdrawalInitiated: toEventSelector(abi[0]),
  ethBridgeInitiated: toEventSelector(abi[1]),
  erc20BridgeInitiated: toEventSelector(abi[2]),
  messagePassed: toEventSelector(abi[3]),
  sentMessage: toEventSelector(abi[4]),
};

/** L2 token address the legacy bridge used for ETH. */
const LEGACY_ERC20_ETH = "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";
/** OP Mainnet's pre-Bedrock L1CrossDomainMessenger (still the L1 messenger today). */
const OP_L1_MESSENGER: Address = "0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1";
/** First Bedrock block on OP Mainnet (June 6, 2023). */
const OP_BEDROCK_BLOCK = 105_235_063n;

interface BridgeTransfer {
  l1Token: Address | null; // null = ETH
  amount: bigint;
}

/** Bridge-level transfers made by `user` in a receipt, in log order. */
function bridgeTransfers(net: Network, receipt: TransactionReceipt, user: Address): BridgeTransfer[] {
  const bridge = net.contracts.l2StandardBridge as Address;
  const legacy: BridgeTransfer[] = [];
  const modern: BridgeTransfer[] = [];
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, bridge)) continue;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === "WithdrawalInitiated" && isAddressEqual(ev.args.from, user)) {
        const isEth = isAddressEqual(ev.args.l2Token, LEGACY_ERC20_ETH);
        legacy.push({ l1Token: isEth ? null : ev.args.l1Token, amount: ev.args.amount });
      } else if (ev.eventName === "ETHBridgeInitiated" && isAddressEqual(ev.args.from, user)) {
        modern.push({ l1Token: null, amount: ev.args.amount });
      } else if (ev.eventName === "ERC20BridgeInitiated" && isAddressEqual(ev.args.from, user)) {
        modern.push({ l1Token: ev.args.remoteToken, amount: ev.args.amount });
      }
    } catch {
      /* not one of ours */
    }
  }
  // Bedrock bridges emit both the legacy and the new event for the same transfer.
  return legacy.length ? legacy : modern;
}

async function toAsset(net: Network, t: BridgeTransfer | undefined, fallbackEth: bigint): Promise<Asset> {
  if (!t) return ethAsset(fallbackEth);
  if (!t.l1Token) return ethAsset(t.amount);
  return tokenAsset([l1Client(), l2Client(net)], t.l1Token, t.amount, "ethereum");
}

/** Pre-Bedrock OP Mainnet withdrawals: relayed through the L1 messenger, keyed by the legacy message hash. */
async function checkLegacy(
  net: Network,
  receipt: TransactionReceipt,
  user: Address,
  timestamp: number,
  out: CheckOutput,
) {
  const transfers = bridgeTransfers(net, receipt, user);
  const messenger = net.contracts.l2CrossDomainMessenger as Address;
  const messages = receipt.logs
    .filter((l) => isAddressEqual(l.address, messenger) && l.topics[0] === T.sentMessage)
    .map((l) => decodeEventLog({ abi, data: l.data, topics: l.topics }))
    .filter((ev) => ev.eventName === "SentMessage");

  for (const [i, ev] of messages.entries()) {
    if (ev.eventName !== "SentMessage") continue;
    const hash = keccak256(
      encodeFunctionData({
        abi: legacyMessengerAbi,
        functionName: "relayMessage",
        args: [ev.args.target, ev.args.sender, ev.args.message, ev.args.messageNonce],
      }),
    );
    const relayed = await l1Client().readContract({
      address: OP_L1_MESSENGER,
      abi: legacyMessengerAbi,
      functionName: "successfulMessages",
      args: [hash],
    });
    if (relayed) {
      out.completed++;
      continue;
    }
    const t = transfers[i];
    if (!t && !isAddressEqual(ev.args.sender, user)) continue;
    out.findings.push(
      makeFinding(net, {
        key: `legacy-${i}`,
        status: "manual",
        asset: await toAsset(net, t, 0n),
        txHash: receipt.transactionHash,
        timestamp,
        note: "Pre-Bedrock withdrawal (before June 6, 2023). Most bridge apps don't show these; see the guide below.",
      }),
    );
  }
}

async function checkReceipt(net: Network, receipt: TransactionReceipt, user: Address, timestamp: number, out: CheckOutput) {
  const withdrawals = getWithdrawals({ logs: receipt.logs });
  if (!withdrawals.length) {
    if (net.id === "optimism" && receipt.blockNumber < OP_BEDROCK_BLOCK)
      await checkLegacy(net, receipt, user, timestamp, out);
    return;
  }

  const transfers = bridgeTransfers(net, receipt, user);
  const targetChain = net.chain as Chain & { contracts: Record<string, unknown> };

  for (const [i, w] of withdrawals.entries()) {
    const t = transfers[i];
    // Only withdrawals made by this user: through the bridge, or sent directly.
    if (!t && !isAddressEqual(w.sender, user)) continue;

    // viem handles legacy output oracles, fault-proof dispute games and re-proving.
    const status = await getWithdrawalStatus(l1Client(), {
      receipt,
      logIndex: i,
      targetChain,
      chain: L1.chain,
    } as unknown as Parameters<typeof getWithdrawalStatus>[1]);

    if (status === "finalized") {
      out.completed++;
      continue;
    }

    const asset = await toAsset(net, t, w.value);
    const age = now() - timestamp;
    let readyAt: number | undefined;
    let s: Finding["status"];
    switch (status) {
      case "ready-to-finalize":
        s = "ready";
        break;
      case "ready-to-prove":
        s = age < 7 * DAY ? "recent" : "prove";
        break;
      case "waiting-to-prove":
        s = "recent";
        break;
      case "waiting-to-finalize": {
        s = age < 7 * DAY ? "recent" : "waiting";
        try {
          const ttf = await getTimeToFinalize(l1Client(), {
            withdrawalHash: w.withdrawalHash,
            targetChain,
            chain: L1.chain,
          } as unknown as Parameters<typeof getTimeToFinalize>[1]);
          readyAt = Math.floor(ttf.timestamp / 1000);
        } catch {
          /* optional */
        }
        break;
      }
      default:
        s = "manual";
    }
    out.findings.push(
      makeFinding(net, { key: w.withdrawalHash, status: s, asset, txHash: receipt.transactionHash, timestamp, readyAt }),
    );
  }
}

export async function checkOpStack(net: Network, user: Address): Promise<CheckOutput> {
  const u = addressTopic(user);
  const bridge = net.contracts.l2StandardBridge as Address;
  const passer = net.contracts.l2ToL1MessagePasser as Address;

  const logs = (
    await Promise.all([
      getLogs(net, bridge, [T.withdrawalInitiated, null, null, u]),
      getLogs(net, bridge, [T.ethBridgeInitiated, u]),
      getLogs(net, bridge, [T.erc20BridgeInitiated, null, null, u]),
      getLogs(net, passer, [T.messagePassed, null, u]), // direct withdrawals
    ])
  ).flat();

  const out: CheckOutput = { findings: [], completed: 0 };
  const txs = [...uniqueTxs(logs)];
  await mapLimit(txs, 3, async ([hash, timestamp]: [Hex, number]) => {
    const receipt = await l2Client(net).getTransactionReceipt({ hash });
    if (receipt.status !== "success") return;
    await checkReceipt(net, receipt, user, timestamp, out);
  });
  return out;
}
