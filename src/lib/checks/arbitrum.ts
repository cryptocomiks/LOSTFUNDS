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
import { addressTopic, findBridgeTxs } from "../explorer";
import type { Network } from "../networks";
import { ethAsset, mapLimit, tokenAsset } from "../tokens";
import type { Asset } from "../types";
import { DAY, makeFinding, unclaimedStatus, type CheckOutput } from "./common";

const ARBSYS: Address = "0x0000000000000000000000000000000000000064";

const abi = parseAbi([
  "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
  "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
]);
const outboxAbi = parseAbi(["function isSpent(uint256 index) view returns (bool)"]);

const T = {
  l2ToL1Tx: toEventSelector(abi[0]),
  withdrawalInitiated: toEventSelector(abi[1]),
};

/** Challenge period (~6.4 days) plus a margin for the assertion to be confirmed. */
const FINALITY = 7 * DAY;

/**
 * The chain's gas token, in which ArbSys withdrawals (`callvalue`) are paid out: ETH, or on chains with
 * their own gas token (Plume, Gravity…) that token, released on Ethereum by the chain's bridge.
 * `callvalue` always has the L2 native currency's decimals.
 */
export function nativeAsset(net: Network, amount: bigint): Asset {
  const token = net.contracts.nativeToken as Address | undefined;
  if (!token) return ethAsset(amount);
  const { symbol, decimals } = net.chain.nativeCurrency;
  return { symbol, decimals, amount, token, tokenChain: "ethereum" };
}

async function checkReceipt(net: Network, receipt: TransactionReceipt, user: Address, timestamp: number, out: CheckOutput) {
  const gateways = (net.contracts.gateways as Address[]).map((g) => g.toLowerCase());
  const tokenTransfers: { l1Token: Address; amount: bigint }[] = [];
  const messages: { position: bigint; destination: Address; callvalue: bigint }[] = [];

  for (const log of receipt.logs) {
    try {
      if (isAddressEqual(log.address, ARBSYS) && log.topics[0] === T.l2ToL1Tx) {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics, eventName: "L2ToL1Tx" });
        messages.push({ position: ev.args.position, destination: ev.args.destination, callvalue: ev.args.callvalue });
      } else if (gateways.includes(log.address.toLowerCase()) && log.topics[0] === T.withdrawalInitiated) {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics, eventName: "WithdrawalInitiated" });
        if (isAddressEqual(ev.args._from, user)) tokenTransfers.push({ l1Token: ev.args.l1Token, amount: ev.args._amount });
      }
    } catch {
      /* not one of ours */
    }
  }

  // Classic (pre-Nitro, before Aug 31, 2022) token withdrawals have no Nitro L2ToL1Tx event.
  if (!messages.length) {
    for (const [i, t] of tokenTransfers.entries())
      out.findings.push(
        makeFinding(net, {
          key: `classic-${i}`,
          status: "manual",
          asset: await tokenAsset([l1Client(), l2Client(net)], t.l1Token, t.amount, "ethereum"),
          txHash: receipt.transactionHash,
          timestamp,
          note: "Pre-Nitro (Arbitrum Classic) withdrawal. Check its status in the official bridge.",
        }),
      );
    return;
  }

  const hasTokens = tokenTransfers.length > 0;
  const mine = hasTokens
    ? messages // token withdrawals: the gateway event already proved it's the user's
    : messages.filter(
        (m) => m.callvalue > 0n && (isAddressEqual(m.destination, user) || isAddressEqual(receipt.from, user)),
      );

  for (const [i, m] of mine.entries()) {
    const spent = await l1Client().readContract({
      address: net.contracts.outbox as Address,
      abi: outboxAbi,
      functionName: "isSpent",
      args: [m.position],
    });
    if (spent) {
      out.completed++;
      continue;
    }
    const t = hasTokens ? tokenTransfers[i] : undefined;
    const asset = t
      ? await tokenAsset([l1Client(), l2Client(net)], t.l1Token, t.amount, "ethereum")
      : nativeAsset(net, m.callvalue);
    out.findings.push(
      makeFinding(net, {
        key: m.position.toString(),
        asset,
        txHash: receipt.transactionHash,
        timestamp,
        ...unclaimedStatus(timestamp, FINALITY),
      }),
    );
  }
}

export async function checkArbitrum(net: Network, user: Address): Promise<CheckOutput> {
  const u = addressTopic(user);
  const gateways = net.contracts.gateways as Address[];
  const txs = await findBridgeTxs(net, user, {
    targets: [ARBSYS, net.contracts.gatewayRouter as Address, ...gateways],
    logs: [
      [ARBSYS, [T.l2ToL1Tx, u]], // ETH withdrawals (destination = user)
      ...gateways.map((g) => [g, [T.withdrawalInitiated, u]] as [Address, [Hex, Hex]]),
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
