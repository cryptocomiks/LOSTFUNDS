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
  zeroAddress,
} from "viem";
import { getTimeToFinalize, getWithdrawalStatus, getWithdrawals } from "viem/op-stack";
import { l1Client, l2Client } from "../clients";
import { addressTopic, findBridgeTxs, type Topics } from "../explorer";
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
const mantlePasserAbi = parseAbi([
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 mntValue, uint256 ethValue, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
]);
const legacyPortalAbi = parseAbi([
  "function provenWithdrawals(bytes32) view returns (bytes32 outputRoot, uint128 timestamp, uint128 l2OutputIndex)",
]);
const outputOracleAbi = parseAbi([
  "function getL2Output(uint256) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
]);
const portal2Abi = parseAbi([
  "function finalizedWithdrawals(bytes32) view returns (bool)",
  "function numProofSubmitters(bytes32) view returns (uint256)",
  "function proofSubmitters(bytes32, uint256) view returns (address)",
  "function provenWithdrawals(bytes32, address) view returns (address disputeGameProxy, uint64 timestamp)",
  "function checkWithdrawal(bytes32, address) view",
  "function anchorStateRegistry() view returns (address)",
  "error OptimismPortal_ProofNotOldEnough()",
  "error OptimismPortal_InvalidRootClaim()",
  "error OptimismPortal_Unproven()",
  "error OptimismPortal_InvalidProofTimestamp()",
]);
const anchorStateRegistryAbi = parseAbi([
  "function isGameProper(address) view returns (bool)",
  "function isGameRespected(address) view returns (bool)",
  "function isGameFinalized(address) view returns (bool)",
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
  mantleMessagePassed: toEventSelector(mantlePasserAbi[0]),
};

/**
 * Mantle v2 is an OP Stack fork with MNT as its native currency and ETH as a bridged token (BVM_ETH).
 * Its message passer emits its own MessagePassed event carrying both values, and its bridge's ETH
 * events move BVM_ETH (MNT goes through WithdrawalInitiated with the L1 MNT token). Only these two
 * points differ: statuses come from the same portal / output oracle as any legacy OP Stack chain.
 */
const isMantle = (net: Network) => net.id === "mantle";

/** L2 token address the legacy bridge used for ETH. */
const LEGACY_ERC20_ETH = "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";
/** OP Mainnet's pre-Bedrock L1CrossDomainMessenger (still the L1 messenger today). */
const OP_L1_MESSENGER: Address = "0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1";
/** First Bedrock block on OP Mainnet (June 6, 2023). */
const OP_BEDROCK_BLOCK = 105_235_063n;

/** The standard L2 bridge, plus chain-specific ones (e.g. Blast's L2BlastBridge). */
const l2Bridges = (net: Network) => [net.contracts.l2StandardBridge as Address, ...((net.contracts.extraBridges as Address[] | undefined) ?? [])];

interface BridgeTransfer {
  l1Token: Address | null; // null = the bridge's ETH path (see ethPathAsset)
  amount: bigint;
}

/** Bridge-level transfers made by `user` in a receipt, in log order. */
function bridgeTransfers(net: Network, receipt: TransactionReceipt, user: Address): BridgeTransfer[] {
  const bridges = l2Bridges(net);
  const legacy: BridgeTransfer[] = [];
  const modern: BridgeTransfer[] = [];
  for (const log of receipt.logs) {
    if (!bridges.some((b) => isAddressEqual(log.address, b))) continue;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === "WithdrawalInitiated" && isAddressEqual(ev.args.from, user)) {
        // ETH has no L1 token. Its L2 token varies: 0xDeaD…0000 (OP), 0x4200…0006 (Boba), BVM_ETH (Mantle).
        const isEth = isAddressEqual(ev.args.l1Token, zeroAddress) || isAddressEqual(ev.args.l2Token, LEGACY_ERC20_ETH);
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

/** An amount of the L2's native currency: ETH, or the token it is bridged from on Ethereum (CELO, HSK, MNT…). */
function nativeAsset(net: Network, amount: bigint): Asset {
  const native = net.nativeToken;
  if (!native) return ethAsset(amount);
  const { symbol, decimals } = net.chain.nativeCurrency;
  return { symbol, decimals, amount, token: native.l1Token, tokenChain: "ethereum", ...(native.priceKey && { priceKey: native.priceKey }) };
}

/** The bridge's ETH path moves the L2's native currency, except on Mantle where it moves bridged ETH. */
const ethPathAsset = (net: Network, amount: bigint) => (isMantle(net) ? ethAsset(amount) : nativeAsset(net, amount));

async function toAsset(net: Network, t: BridgeTransfer | undefined, fallbackNative: bigint): Promise<Asset> {
  if (!t) return nativeAsset(net, fallbackNative);
  if (!t.l1Token) return ethPathAsset(net, t.amount);
  if (net.nativeToken && isAddressEqual(t.l1Token, net.nativeToken.l1Token)) return nativeAsset(net, t.amount);
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

type Status = Awaited<ReturnType<typeof getWithdrawalStatus>>;

/**
 * Status of a withdrawal on a fault-proof portal, read straight from the portal.
 * Used when viem can't list the dispute games (older game contracts lack `l2SequenceNumber`).
 * Unproven withdrawals are reported as ready to prove: games are created every few hours.
 */
async function faultProofStatus(portal: Address, withdrawalHash: Hex, sender: Address): Promise<Status> {
  const c = l1Client();
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    c.readContract({ address: portal, abi: portal2Abi, functionName, args } as never) as Promise<T>;
  if (await read<boolean>("finalizedWithdrawals", [withdrawalHash])) return "finalized";
  const n = await read<bigint>("numProofSubmitters", [withdrawalHash]).catch(() => 1n);
  const submitter = n > 0n ? await read<Address>("proofSubmitters", [withdrawalHash, n - 1n]).catch(() => sender) : sender;
  const [game, provenAt] = await read<[Address, bigint]>("provenWithdrawals", [withdrawalHash, submitter]);
  if (!provenAt) return "ready-to-prove";
  try {
    await read("checkWithdrawal", [withdrawalHash, submitter]);
    return "ready-to-finalize";
  } catch (e) {
    const why = (e as Error).message;
    if (/ProofNotOldEnough|not matured|not been finalized|air-gap/.test(why)) return "waiting-to-finalize";
    if (/InvalidRootClaim/.test(why)) {
      // The game the proof points to must be proper, respected and finalized; otherwise re-prove.
      const registry = await read<Address>("anchorStateRegistry", []);
      // A game retired by an upgrade can make these reads revert: its proofs can't be used any more.
      const ask = (functionName: "isGameProper" | "isGameRespected" | "isGameFinalized") =>
        c.readContract({ address: registry, abi: anchorStateRegistryAbi, functionName, args: [game] }).catch(() => null);
      const [proper, respected, finalized] = await Promise.all([ask("isGameProper"), ask("isGameRespected"), ask("isGameFinalized")]);
      return proper && respected && finalized === false ? "waiting-to-finalize" : "ready-to-prove";
    }
    return "ready-to-prove";
  }
}

type OpChain = Chain & { contracts: Record<"portal" | "disputeGameFactory" | "l2OutputOracle", Record<number, { address: Address }> | undefined> };
const l1Contract = (net: Network, name: "portal" | "disputeGameFactory" | "l2OutputOracle") =>
  (net.chain as OpChain).contracts[name]?.[L1.chain.id]?.address;

/**
 * Legacy portals (output oracle) only check that a withdrawal was proven and the finalization period
 * has passed, but finalizing also needs the output it was proven against to still be in the oracle:
 * if the oracle's outputs were replaced since, the withdrawal must be proven again.
 */
async function legacyProofStands(portal: Address, oracle: Address, withdrawalHash: Hex): Promise<boolean> {
  const [outputRoot, , l2OutputIndex] = await l1Client().readContract({
    address: portal,
    abi: legacyPortalAbi,
    functionName: "provenWithdrawals",
    args: [withdrawalHash],
  });
  const output = await l1Client()
    .readContract({ address: oracle, abi: outputOracleAbi, functionName: "getL2Output", args: [l2OutputIndex] })
    .catch(() => null);
  return output?.outputRoot === outputRoot;
}

async function withdrawalStatus(net: Network, w: Withdrawal, l2BlockNumber: bigint): Promise<Status> {
  const portal = l1Contract(net, "portal")!;
  const oracle = l1Contract(net, "l2OutputOracle");
  const games = l1Contract(net, "disputeGameFactory");
  // viem handles legacy output oracles, fault-proof dispute games and re-proving.
  const status = await getWithdrawalStatus(l1Client(), {
    withdrawalHash: w.withdrawalHash,
    sender: w.sender,
    l2BlockNumber,
    targetChain: net.chain,
    chain: L1.chain,
  } as unknown as Parameters<typeof getWithdrawalStatus>[1]).catch((e) => {
    if (!games) throw e;
    return faultProofStatus(portal, w.withdrawalHash, w.sender);
  });
  if ((status === "waiting-to-finalize" || status === "ready-to-finalize") && oracle && !games)
    if (!(await legacyProofStands(portal, oracle, w.withdrawalHash))) return "ready-to-prove";
  return status;
}

interface Withdrawal {
  withdrawalHash: Hex;
  sender: Address;
  /** Amount of the L2's native currency. */
  value: bigint;
  /** Mantle only: ETH sent along. */
  ethValue?: bigint;
}

/** The withdrawals a transaction started: MessagePassed events of the L2ToL1MessagePasser. */
function receiptWithdrawals(net: Network, receipt: TransactionReceipt): Withdrawal[] {
  const passer = net.contracts.l2ToL1MessagePasser as Address;
  const logs = receipt.logs.filter((l) => isAddressEqual(l.address, passer));
  if (!isMantle(net)) return getWithdrawals({ logs }).map(({ withdrawalHash, sender, value }) => ({ withdrawalHash, sender, value }));
  return logs
    .filter((l) => l.topics[0] === T.mantleMessagePassed)
    .map((l) => {
      const { args } = decodeEventLog({ abi: mantlePasserAbi, data: l.data, topics: l.topics });
      return { withdrawalHash: args.withdrawalHash, sender: args.sender, value: args.mntValue, ethValue: args.ethValue };
    });
}

async function checkReceipt(net: Network, receipt: TransactionReceipt, user: Address, timestamp: number, out: CheckOutput) {
  const withdrawals = receiptWithdrawals(net, receipt);
  if (!withdrawals.length) {
    if (net.id === "optimism" && receipt.blockNumber < OP_BEDROCK_BLOCK)
      await checkLegacy(net, receipt, user, timestamp, out);
    return;
  }

  const transfers = bridgeTransfers(net, receipt, user);

  for (const [i, w] of withdrawals.entries()) {
    const t = transfers[i];
    // Only withdrawals made by this user: through the bridge, or sent directly.
    if (!t && !isAddressEqual(w.sender, user)) continue;

    const status = await withdrawalStatus(net, w, receipt.blockNumber);
    if (status === "finalized") {
      out.completed++;
      continue;
    }

    // What the withdrawal carries. Zero amounts (test transactions, empty messages) have nothing to claim.
    const assets = (t ? [await toAsset(net, t, w.value)] : [nativeAsset(net, w.value), ethAsset(w.ethValue ?? 0n)]).filter(
      (a) => a.amount > 0n,
    );
    if (!assets.length) continue;

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
            targetChain: net.chain,
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
    for (const [j, asset] of assets.entries())
      out.findings.push(
        makeFinding(net, {
          key: j ? `${w.withdrawalHash}:${j}` : w.withdrawalHash,
          status: s,
          asset,
          txHash: receipt.transactionHash,
          timestamp,
          readyAt,
        }),
      );
  }
}

export async function checkOpStack(net: Network, user: Address): Promise<CheckOutput> {
  const u = addressTopic(user);
  const bridge = net.contracts.l2StandardBridge as Address;
  const passer = net.contracts.l2ToL1MessagePasser as Address;

  const extra = l2Bridges(net).slice(1);

  const txs = await findBridgeTxs(net, user, {
    targets: [bridge, passer, net.contracts.l2CrossDomainMessenger as Address, ...extra],
    logs: [
      [bridge, [T.withdrawalInitiated, null, null, u]],
      [bridge, [T.ethBridgeInitiated, u]],
      [bridge, [T.erc20BridgeInitiated, null, null, u]],
      [passer, [isMantle(net) ? T.mantleMessagePassed : T.messagePassed, null, u]], // direct withdrawals
      ...extra.flatMap((b): [Address, Topics][] => [
        [b, [T.ethBridgeInitiated, u]],
        [b, [T.erc20BridgeInitiated, null, null, u]],
      ]),
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
