import {
  decodeEventLog,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { l1Client, l2Client } from "../clients";
import { addressTopic, findBridgeTxs } from "../explorer";
import type { Network } from "../networks";
import { ethAsset, mapLimit, tokenAsset } from "../tokens";
import { DAY, makeFinding, unclaimedStatus, type CheckOutput } from "./common";

const abi = parseAbi([
  "event SentMessage(address indexed sender, address indexed target, uint256 value, uint256 messageNonce, uint256 gasLimit, bytes message)",
  "event WithdrawETH(address indexed from, address indexed to, uint256 amount, bytes data)",
  "event WithdrawERC20(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes data)",
]);
const messengerAbi = parseAbi([
  "function relayMessage(address from, address to, uint256 value, uint256 nonce, bytes message)",
  "function isL2MessageExecuted(bytes32) view returns (bool)",
]);

const T = {
  sentMessage: toEventSelector(abi[0]),
  withdrawEth: toEventSelector(abi[1]),
  withdrawErc20: toEventSelector(abi[2]),
};

/** Withdrawals can be claimed once their batch is finalized on Ethereum (usually within hours). */
const FINALITY = 1 * DAY;

async function checkReceipt(net: Network, receipt: TransactionReceipt, user: Address, timestamp: number, out: CheckOutput) {
  const c = net.contracts;
  const gateways = [c.ethGateway as Address, ...(c.erc20Gateways as Address[])];
  const transfers: { l1Token: Address | null; amount: bigint }[] = [];
  const messages: { sender: Address; target: Address; value: bigint; nonce: bigint; message: Hex }[] = [];

  for (const log of receipt.logs) {
    try {
      if (isAddressEqual(log.address, c.l2Messenger as Address) && log.topics[0] === T.sentMessage) {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics, eventName: "SentMessage" });
        messages.push({ ...ev.args, nonce: ev.args.messageNonce });
      } else if (gateways.some((g) => isAddressEqual(log.address, g))) {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (ev.eventName === "WithdrawETH" && isAddressEqual(ev.args.from, user))
          transfers.push({ l1Token: null, amount: ev.args.amount });
        if (ev.eventName === "WithdrawERC20" && isAddressEqual(ev.args.from, user))
          transfers.push({ l1Token: ev.args.l1Token, amount: ev.args.amount });
      }
    } catch {
      /* not one of ours */
    }
  }

  for (const [i, m] of messages.entries()) {
    const t = transfers[i];
    if (!t && !(isAddressEqual(m.sender, user) && m.value > 0n)) continue;

    const hash = keccak256(
      encodeFunctionData({
        abi: messengerAbi,
        functionName: "relayMessage",
        args: [m.sender, m.target, m.value, m.nonce, m.message],
      }),
    );
    const executed = await l1Client().readContract({
      address: c.l1Messenger as Address,
      abi: messengerAbi,
      functionName: "isL2MessageExecuted",
      args: [hash],
    });
    if (executed) {
      out.completed++;
      continue;
    }
    const asset =
      t && t.l1Token
        ? await tokenAsset([l1Client(), l2Client(net)], t.l1Token, t.amount, "ethereum")
        : ethAsset(t ? t.amount : m.value);
    out.findings.push(
      makeFinding(net, { key: hash, asset, txHash: receipt.transactionHash, timestamp, ...unclaimedStatus(timestamp, FINALITY) }),
    );
  }
}

export async function checkScroll(net: Network, user: Address): Promise<CheckOutput> {
  const u = addressTopic(user);
  const c = net.contracts;
  const erc20 = c.erc20Gateways as Address[];
  const txs = await findBridgeTxs(net, user, {
    targets: [c.gatewayRouter as Address, c.l2Messenger as Address, c.ethGateway as Address, ...erc20],
    logs: [
      [c.l2Messenger as Address, [T.sentMessage, u]], // direct messages
      [c.ethGateway as Address, [T.withdrawEth, u]],
      ...erc20.map((g) => [g, [T.withdrawErc20, null, null, u]] as [Address, [Hex, null, null, Hex]]),
    ],
  });

  const out: CheckOutput = { findings: [], completed: 0 };
  await mapLimit([...txs], 3, async ([hash, timestamp]: [Hex, number]) => {
    const receipt = await l2Client(net).getTransactionReceipt({ hash });
    if (receipt.status !== "success") return;
    await checkReceipt(net, receipt, user, timestamp, out);
  });
  return out;
}
