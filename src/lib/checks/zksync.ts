import {
  BaseError,
  decodeAbiParameters,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  isAddressEqual,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { l1Client, l2Client } from "../clients";
import { addressTopic, getLogs, type Topics } from "../explorer";
import type { Network } from "../networks";
import { ethAsset, mapLimit, tokenAsset } from "../tokens";
import type { Asset, WithdrawalStatus } from "../types";
import { DAY, makeFinding, now, type CheckOutput } from "./common";

/**
 * ZKsync Era and ZK Stack chains. A withdrawal is an L2→L1 message sent by a bridge contract;
 * it can be finalized on Ethereum once its batch has been executed there (about 3 hours on Era).
 * Nobody finalizes withdrawals automatically: the user (or anyone) has to send the claim.
 */

/** Bridge contracts on Ethereum, shared by every ZK Stack chain that settles there. */
const L1_NULLIFIER: Address = "0xD7f9f54194C633F36CCD5F3da84ad4a1c38cB2cB"; // the former L1SharedBridge
const L1_NATIVE_TOKEN_VAULT: Address = "0xbeD1EB542f9a5aA6419Ff3deb921A372681111f6";
/** ZKsync Era's pre-2024 L1ERC20Bridge. */
const ERA_L1_ERC20_BRIDGE: Address = "0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063";
const ERA_CHAIN_ID = 324;
/**
 * First Era batch after the shared-bridge upgrade (June 2024), read from L1Nullifier storage.
 * Older withdrawals may have been finalized through the Era diamond (ETH) or the L1ERC20Bridge
 * (tokens), which kept their own records: the Nullifier's isWithdrawalFinalized doesn't see those.
 */
const ERA_LEGACY_BATCH = 484_171n;

/** L2 system contracts (same address on every ZK Stack chain). */
const L2_BASE_TOKEN: Address = "0x000000000000000000000000000000000000800A";
const L2_ASSET_ROUTER: Address = "0x0000000000000000000000000000000000010003";
const L1_MESSENGER: Address = "0x0000000000000000000000000000000000008008";
/** How the bridge contracts denote ETH. */
const ETH_TOKEN: Address = "0x0000000000000000000000000000000000000001";

/** Tokens DefiLlama doesn't price, priced as the token they wrap. */
const PRICED_AS: Record<string, string> = {
  "0x1ff1dc3cb9eedbc6eb2d99c03b30a05ca625fb5a": "ethereum:0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", // Lens LGHO → GHO
};

const abi = parseAbi([
  "event Withdrawal(address indexed _l2Sender, address indexed _l1Receiver, uint256 _amount)",
  "event WithdrawalWithMessage(address indexed _l2Sender, address indexed _l1Receiver, uint256 _amount, bytes _additionalData)",
  "event WithdrawalInitiated(address indexed l2Sender, address indexed l1Receiver, address indexed l2Token, uint256 amount)",
  "event WithdrawalInitiatedAssetRouter(uint256 chainId, address indexed l2Sender, bytes32 indexed assetId, bytes assetData)",
  "event L1MessageSent(address indexed _sender, bytes32 indexed _hash, bytes _message)",
]);
const nullifierAbi = parseAbi([
  "function isWithdrawalFinalized(uint256 chainId, uint256 l2BatchNumber, uint256 l2ToL1MessageNumber) view returns (bool)",
  "struct FinalizeL1DepositParams { uint256 chainId; uint256 l2BatchNumber; uint256 l2MessageIndex; address l2Sender; uint16 l2TxNumberInBatch; bytes message; bytes32[] merkleProof; }",
  "function finalizeDeposit(FinalizeL1DepositParams params)",
]);
const legacyAbi = parseAbi([
  "function isEthWithdrawalFinalized(uint256 l2BatchNumber, uint256 l2MessageIndex) view returns (bool)",
  "function isWithdrawalFinalized(uint256 l2BatchNumber, uint256 l2MessageIndex) view returns (bool)",
  "function getTotalBatchesExecuted() view returns (uint256)",
]);
const ntvAbi = parseAbi(["function tokenAddress(bytes32 assetId) view returns (address)"]);

const T = {
  withdrawal: toEventSelector(abi[0]),
  withdrawalWithMessage: toEventSelector(abi[1]),
  withdrawalInitiated: toEventSelector(abi[2]),
  withdrawalInitiatedAssetRouter: toEventSelector(abi[3]),
  l1MessageSent: toEventSelector(abi[4]),
};

/** Message selectors: what the L1 bridge is asked to do. */
const MSG = {
  base: "0x6c0960f9", // finalizeEthWithdrawal: the chain's base token (ETH, SOPH, LGHO, zkCRO…)
  legacy: "0x11a2ccc1", // finalizeWithdrawal: the legacy ERC20 bridge format
  router: "0x9c884fd1", // finalizeDeposit: the asset router format
} as const;
/** L1Nullifier's WithdrawalAlreadyFinalized() error. */
const ALREADY_FINALIZED = "0xae899454";

interface ZkReceipt {
  transactionHash: Hex;
  from: Address;
  status: Hex;
  l1BatchNumber: Hex | null;
  l1BatchTxIndex: Hex | null;
  logs: { address: Address; topics: Hex[]; data: Hex }[];
  l2ToL1Logs: { sender: Address; key: Hex; value: Hex }[];
}

interface Message {
  kind: keyof typeof MSG;
  receiver: Address;
  amount: bigint;
  /** L1 token (legacy format). */
  l1Token?: Address;
  /** Asset router format. */
  assetId?: Hex;
  originToken?: Address;
  sender?: Address;
}

export function decodeMessage(m: Hex): Message | null {
  try {
    const sel = slice(m, 0, 4);
    if (sel === MSG.base && size(m) >= 56)
      return { kind: "base", receiver: getAddress(slice(m, 4, 24)), amount: hexToBigInt(slice(m, 24, 56)) };
    if (sel === MSG.legacy && size(m) >= 76)
      return {
        kind: "legacy",
        receiver: getAddress(slice(m, 4, 24)),
        l1Token: getAddress(slice(m, 24, 44)),
        amount: hexToBigInt(slice(m, 44, 76)),
      };
    if (sel === MSG.router) {
      // chainId (32 bytes), assetId (32 bytes), then abi.encode(originalCaller, receiver, originToken, amount, metadata)
      const [sender, receiver, originToken, amount] = decodeAbiParameters(
        parseAbiParameters("address, address, address, uint256"),
        slice(m, 68),
      );
      return { kind: "router", receiver, amount, assetId: slice(m, 36, 68), originToken, sender };
    }
  } catch {
    /* malformed */
  }
  return null;
}

/** The withdrawals in a receipt, with the index of their L2→L1 log (needed for the proof). */
function withdrawalsIn(net: Network, rc: ZkReceipt) {
  const legacyBridge = net.contracts.l2LegacyBridge as Address;
  const bridges = [L2_BASE_TOKEN, L2_ASSET_ROUTER, legacyBridge];

  // Who started each withdrawal, from the bridges' events (same order as their messages).
  const baseSenders: Address[] = [];
  const tokenSenders: Address[] = [];
  for (const log of rc.logs) {
    try {
      if (isAddressEqual(log.address, L2_BASE_TOKEN) && (log.topics[0] === T.withdrawal || log.topics[0] === T.withdrawalWithMessage)) {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (ev.eventName === "Withdrawal" || ev.eventName === "WithdrawalWithMessage") baseSenders.push(ev.args._l2Sender);
      } else if (
        (isAddressEqual(log.address, legacyBridge) && log.topics[0] === T.withdrawalInitiated) ||
        (isAddressEqual(log.address, L2_ASSET_ROUTER) && log.topics[0] === T.withdrawalInitiatedAssetRouter)
      ) {
        tokenSenders.push(getAddress(slice(log.topics[1], 12)));
      }
    } catch {
      /* not one of ours */
    }
  }

  const used = new Set<number>();
  const out: { index: number; bridge: Address; message: Hex; w: Message }[] = [];
  let b = 0;
  let t = 0;
  rc.l2ToL1Logs.forEach((l, index) => {
    if (!isAddressEqual(l.sender, L1_MESSENGER)) return;
    const from = getAddress(slice(l.key, 12));
    if (!bridges.some((a) => isAddressEqual(a, from))) return;
    const at = rc.logs.findIndex(
      (x, j) =>
        !used.has(j) &&
        isAddressEqual(x.address, L1_MESSENGER) &&
        x.topics[0] === T.l1MessageSent &&
        x.topics[2]?.toLowerCase() === l.value.toLowerCase(),
    );
    if (at < 0) return;
    used.add(at);
    const [message] = decodeAbiParameters([{ type: "bytes" }], rc.logs[at].data);
    const w = decodeMessage(message);
    const eventSender = isAddressEqual(from, L2_BASE_TOKEN) ? baseSenders[b++] : tokenSenders[t++];
    if (w) out.push({ index, bridge: from, message, w: { ...w, sender: w.sender ?? eventSender } });
  });
  return out;
}

async function l1TokenAsset(net: Network, token: Address, amount: bigint): Promise<Asset> {
  const asset = await tokenAsset([l1Client(), l2Client(net)], token, amount, "ethereum");
  const priceKey = PRICED_AS[token.toLowerCase()];
  return priceKey ? { ...asset, priceKey } : asset;
}

async function assetOf(net: Network, w: Message): Promise<Asset> {
  if (w.kind === "base") {
    const base = net.contracts.baseToken as Address | undefined;
    return base ? l1TokenAsset(net, base, w.amount) : ethAsset(w.amount);
  }
  let token = w.l1Token;
  if (w.kind === "router") {
    const l1 = await l1Client()
      .readContract({ address: L1_NATIVE_TOKEN_VAULT, abi: ntvAbi, functionName: "tokenAddress", args: [w.assetId!] })
      .catch(() => zeroAddress);
    // Not on Ethereum yet: a token created on the L2, deployed on Ethereum by the first claim.
    if (isAddressEqual(l1, zeroAddress)) return tokenAsset([l2Client(net), l1Client()], w.originToken!, w.amount, net.llama);
    token = l1;
  }
  if (isAddressEqual(token!, ETH_TOKEN)) return ethAsset(w.amount);
  return l1TokenAsset(net, token!, w.amount);
}

/** Revert data of a failed eth_call, if the node returned any. */
function revertData(e: unknown): Hex | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const inner = e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null;
  return inner?.data;
}

async function isFinalized(net: Network, batch: bigint, id: bigint, kind: Message["kind"]): Promise<boolean> {
  const c = l1Client();
  const chainId = BigInt(net.chain.id);
  const reads: Promise<boolean>[] = [
    c.readContract({ address: L1_NULLIFIER, abi: nullifierAbi, functionName: "isWithdrawalFinalized", args: [chainId, batch, id] }),
  ];
  if (net.chain.id === ERA_CHAIN_ID && batch < ERA_LEGACY_BATCH)
    reads.push(
      kind === "base"
        ? c.readContract({ address: net.contracts.diamond as Address, abi: legacyAbi, functionName: "isEthWithdrawalFinalized", args: [batch, id] })
        : c.readContract({ address: ERA_L1_ERC20_BRIDGE, abi: legacyAbi, functionName: "isWithdrawalFinalized", args: [batch, id] }),
    );
  return (await Promise.all(reads)).some(Boolean);
}

/**
 * Dry-runs the claim on Ethereum: the bridge's own verdict (proof valid, already finalized…).
 * L1Nullifier.finalizeDeposit takes the L2 sender explicitly. The legacy finalizeWithdrawal
 * (L1AssetRouter) assumes token messages come from the legacy bridge, so it rejects the proof
 * of withdrawals sent through the asset router.
 */
async function simulateClaim(
  net: Network,
  p: { batch: bigint; id: bigint; txIndex: number; bridge: Address; message: Hex; proof: Hex[] },
): Promise<"ok" | "finalized" | "rejected"> {
  const params = {
    chainId: BigInt(net.chain.id),
    l2BatchNumber: p.batch,
    l2MessageIndex: p.id,
    l2Sender: p.bridge,
    l2TxNumberInBatch: p.txIndex,
    message: p.message,
    merkleProof: p.proof,
  };
  try {
    await l1Client().call({
      to: L1_NULLIFIER,
      data: encodeFunctionData({ abi: nullifierAbi, functionName: "finalizeDeposit", args: [params] }),
      batch: false,
    });
    return "ok";
  } catch (e) {
    const data = revertData(e);
    if (data === undefined && !/revert/i.test((e as Error).message)) throw e; // the node failed, not the claim
    return data?.startsWith(ALREADY_FINALIZED) ? "finalized" : "rejected";
  }
}

const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function checkTx(
  net: Network,
  hash: Hex,
  timestamp: number,
  user: Address,
  executed: () => Promise<bigint>,
  out: CheckOutput,
) {
  const l2 = l2Client(net);
  const rc = (await l2.request({ method: "eth_getTransactionReceipt", params: [hash] } as never)) as ZkReceipt | null;
  if (!rc) throw new Error(`transaction ${hash} not found`);
  if (rc.status !== "0x1") return;

  for (const { index, bridge, message, w } of withdrawalsIn(net, rc)) {
    const toUser = isAddressEqual(w.receiver, user);
    if (!toUser && !(w.sender && isAddressEqual(w.sender, user)) && !isAddressEqual(rc.from, user)) continue;
    if (w.amount === 0n) continue;

    const state = await withdrawalState(net, rc, index, bridge, message, w.kind, executed);
    if (state.status === "completed") {
      out.completed++;
      continue;
    }
    let status: WithdrawalStatus;
    const notes: string[] = [];
    if (state.status === "pending") {
      status = now() - timestamp < 7 * DAY ? "recent" : "waiting";
      if (status === "waiting") notes.push("Its batch hasn't been executed on Ethereum yet. It becomes claimable once it is.");
    } else if (state.status === "rejected") {
      status = "manual";
      notes.push("A dry run of the claim on Ethereum fails. Check this withdrawal in the chain's official bridge.");
    } else status = "ready";
    if (!toUser) notes.push(`The funds go to ${short(w.receiver)} on Ethereum, the receiver set when the withdrawal was made.`);

    out.findings.push(
      makeFinding(net, {
        key: `${index}`,
        status,
        asset: await assetOf(net, w),
        txHash: hash,
        timestamp,
        note: notes.length ? notes.join(" ") : undefined,
      }),
    );
  }
}

/**
 * Where one withdrawal stands on Ethereum:
 * - pending:   its batch isn't sealed, committed or executed on Ethereum yet;
 * - completed: finalized (by anyone: the funds went to the receiver);
 * - ready:     the claim goes through (dry run);
 * - rejected:  the claim reverts for another reason.
 */
async function withdrawalState(
  net: Network,
  rc: ZkReceipt,
  index: number,
  bridge: Address,
  message: Hex,
  kind: Message["kind"],
  executed: () => Promise<bigint>,
): Promise<{ status: "pending" | "completed" | "ready" | "rejected" }> {
  if (rc.l1BatchNumber == null) return { status: "pending" };
  const batch = BigInt(rc.l1BatchNumber);
  const proof = (await l2Client(net).request({
    method: "zks_getL2ToL1LogProof",
    params: [rc.transactionHash, index],
  } as never)) as { id: number; proof: Hex[] } | null;
  if (!proof) return { status: "pending" };

  const id = BigInt(proof.id);
  if (await isFinalized(net, batch, id, kind)) return { status: "completed" };
  if (batch > (await executed())) return { status: "pending" };

  // The tx's index in its batch (not l2ToL1Logs[].transactionIndex, its index in the block).
  const txIndex = Number(BigInt(rc.l1BatchTxIndex ?? "0x0"));
  const verdict = await simulateClaim(net, { batch, id, txIndex, bridge, message, proof: proof.proof });
  return { status: verdict === "finalized" ? "completed" : verdict === "ok" ? "ready" : "rejected" };
}

export async function checkZkSync(net: Network, user: Address): Promise<CheckOutput> {
  const u = addressTopic(user);
  const legacy = net.contracts.l2LegacyBridge as Address;
  // Sent by the user or to the user. The asset router event doesn't index the receiver.
  const queries: [Address, Topics][] = [
    [L2_BASE_TOKEN, [T.withdrawal, u]],
    [L2_BASE_TOKEN, [T.withdrawal, null, u]],
    [L2_BASE_TOKEN, [T.withdrawalWithMessage, u]],
    [L2_BASE_TOKEN, [T.withdrawalWithMessage, null, u]],
    [legacy, [T.withdrawalInitiated, u]],
    [legacy, [T.withdrawalInitiated, null, u]],
    [L2_ASSET_ROUTER, [T.withdrawalInitiatedAssetRouter, u]],
  ];
  // The RPC nodes answer these in well under a second; Era's Blockscout can take 20 s or more.
  const history = { ...net, preferRpc: true };
  const logs = (await Promise.all(queries.map(([a, t]) => getLogs(history, a, t)))).flat();
  const txs = new Map<Hex, number>();
  for (const l of logs) txs.set(l.transactionHash, l.timestamp);

  let executedP: Promise<bigint> | undefined;
  const executed = () =>
    (executedP ??= l1Client().readContract({
      address: net.contracts.diamond as Address,
      abi: legacyAbi,
      functionName: "getTotalBatchesExecuted",
    }));

  const out: CheckOutput = { findings: [], completed: 0 };
  await mapLimit([...txs], 3, ([hash, timestamp]) => checkTx(net, hash, timestamp, user, executed, out));
  return out;
}
