import {
  decodeEventLog,
  isAddressEqual,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { l1Client, l2Client } from "../clients";
import { addressTopic, findBridgeTxs, getLogs } from "../explorer";
import { L1, type Network } from "../networks";
import { ethAsset, mapLimit, tokenAsset } from "../tokens";
import { DAY, makeFinding, unclaimedStatus, type CheckOutput } from "./common";

const abi = parseAbi([
  "event MessageSent(address indexed _from, address indexed _to, uint256 _fee, uint256 _value, uint256 _nonce, bytes _calldata, bytes32 indexed _messageHash)",
  "event BridgingInitiatedV2(address indexed sender, address indexed recipient, address indexed token, uint256 amount)",
  "event BridgingInitiated(address indexed sender, address recipient, address indexed token, uint256 indexed amount)",
  "event MessageClaimed(bytes32 indexed _messageHash)",
]);
const rollupAbi = parseAbi(["function isMessageClaimed(uint256 _messageNumber) view returns (bool)"]);

const T = {
  messageSent: toEventSelector(abi[0]),
  bridgingV2: toEventSelector(abi[1]),
  bridgingV1: toEventSelector(abi[2]),
  messageClaimed: toEventSelector(abi[3]),
};

/** Messages can be claimed once the L2 block is finalized on Ethereum (typically 8–32 hours). */
const FINALITY = 2 * DAY;

async function isClaimed(net: Network, nonce: bigint, hash: Hex): Promise<boolean> {
  const rollup = net.contracts.l1Rollup as Address;
  // Messages sent after the Feb 2024 upgrade are tracked in a bitmap…
  const inBitmap = await l1Client()
    .readContract({ address: rollup, abi: rollupAbi, functionName: "isMessageClaimed", args: [nonce] })
    .catch(() => false);
  if (inBitmap) return true;
  // …older ones aren't, but every claim ever made emits MessageClaimed(hash) on L1.
  const claims = await getLogs(L1, rollup, [T.messageClaimed, hash]);
  return claims.length > 0;
}

async function checkReceipt(net: Network, receipt: TransactionReceipt, user: Address, timestamp: number, out: CheckOutput) {
  const c = net.contracts;
  const transfers: { token: Address; amount: bigint }[] = [];
  const messages: { from: Address; value: bigint; nonce: bigint; hash: Hex }[] = [];

  for (const log of receipt.logs) {
    try {
      if (isAddressEqual(log.address, c.l2MessageService as Address) && log.topics[0] === T.messageSent) {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics, eventName: "MessageSent" });
        messages.push({ from: ev.args._from, value: ev.args._value, nonce: ev.args._nonce, hash: ev.args._messageHash });
      } else if (isAddressEqual(log.address, c.l2TokenBridge as Address)) {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (
          (ev.eventName === "BridgingInitiatedV2" || ev.eventName === "BridgingInitiated") &&
          isAddressEqual(ev.args.sender, user)
        )
          transfers.push({ token: ev.args.token, amount: ev.args.amount });
      }
    } catch {
      /* not one of ours */
    }
  }

  const bridgeMessages = messages.filter((m) => isAddressEqual(m.from, c.l2TokenBridge as Address));
  const direct = messages.filter((m) => isAddressEqual(m.from, user) && m.value > 0n);

  const items = [
    ...bridgeMessages.map((m, i) => ({ m, t: transfers[i] })).filter((x) => x.t),
    ...direct.map((m) => ({ m, t: undefined })),
  ];

  for (const { m, t } of items) {
    if (await isClaimed(net, m.nonce, m.hash)) {
      out.completed++;
      continue;
    }
    const asset = t ? await tokenAsset([l2Client(net), l1Client()], t.token, t.amount, net.llama) : ethAsset(m.value);
    out.findings.push(
      makeFinding(net, { key: m.hash, asset, txHash: receipt.transactionHash, timestamp, ...unclaimedStatus(timestamp, FINALITY) }),
    );
  }
}

export async function checkLinea(net: Network, user: Address): Promise<CheckOutput> {
  const u = addressTopic(user);
  const c = net.contracts;
  const txs = await findBridgeTxs(net, user, {
    targets: [c.l2MessageService as Address, c.l2TokenBridge as Address],
    logs: [
      [c.l2MessageService as Address, [T.messageSent, u]], // ETH withdrawals
      [c.l2TokenBridge as Address, [T.bridgingV2, u]],
      [c.l2TokenBridge as Address, [T.bridgingV1, u]],
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
