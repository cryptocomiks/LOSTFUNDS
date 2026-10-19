import { base64 } from "@scure/base";
import { bytesToHex, concat, encodeFunctionData, keccak256, numberToHex, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Asset } from "../types";
import { dryRun, DUST_ETHEREUM } from "./claims";
import { makeFinding, siteFile, type CheckOutput, type FindingSource } from "./common";

/**
 * zkSync Lite (zkSync 1.0) stopped producing blocks on May 4, 2026. Matter Labs published its final state, and every
 * balance in it (ETH and ERC-20s) became a leaf of a Merkle tree whose root is in a claim contract on Ethereum
 * (ZkSyncLiteSunsetClaimDistributorL1, now run by ZKsync's governance), funded with the rollup's assets: 8,485 ETH and
 * about $4.5M of tokens were still unclaimed on Oct 19, 2026. There is no deadline. A leaf is
 * keccak256(index ‖ claimant ‖ token ‖ amount), and claim(index, token, amount, proof) pays it to the claimant.
 *
 * The tree has 16.6 million leaves (mostly NFTs, empty balances and dust). Its proofs only exist in Matter Labs' 463 MB
 * snapshot, and behind lite.zksync.io's API, which only answers its own page (CORS). So the site ships the leaves worth
 * at least $200 on Oct 19, 2026 and still unclaimed then (25,845 for 24,906 addresses, $10.7M), rebuilt from the
 * snapshot and checked against the on-chain root, split by the address's first two hex digits
 * (public/legacy/zksync-lite). Each file holds its leaves and the tree nodes their proofs need, once each, in canonical
 * order (by level, then position), so the order is recomputed here instead of being shipped.
 *
 * Per address: that file (most addresses stop there), then one multicall (the root, isClaimed of each leaf) and a dry
 * run of each unclaimed leaf's claim from the user.
 */

export const ZKSYNC_LITE: FindingSource = { id: "zksync-lite", name: "zkSync Lite", guideId: "zksync-lite", explorer: "https://etherscan.io" };

export const ZKSYNC_LITE_CLAIM: Address = "0x0a14B696350546110a0D8acDb86226983af9D2a0";
/** The claim contract's MERKLE_ROOT, rebuilt from the snapshot. */
export const ZKSYNC_LITE_ROOT: Hex = "0x7b4a44a4f8e14f03efcd4fe625b29755eb275f8621e69167fcd152c86ab37141";
const LEAVES = 16_619_318;
/** Block production stopped on May 4, 2026, 09:00 UTC. */
const SHUTDOWN = 1777885200;

/** zkSync Lite's own token ids of the tokens in the published files. */
export const ZKSYNC_LITE_TOKENS: Record<number, { address: Address; symbol: string; decimals: number }> = {
  0: { address: zeroAddress, symbol: "ETH", decimals: 18 },
  1: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
  2: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
  4: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
  6: { address: "0x4Fabb145d64652a948d72533023f6E7A623C7C53", symbol: "BUSD", decimals: 18 },
  10: { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", decimals: 18 },
  12: { address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", symbol: "MKR", decimals: 18 },
  15: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
  22: { address: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e", symbol: "YFI", decimals: 18 },
  23: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI", decimals: 18 },
  25: { address: "0x8dAEBADE922dF735c38C80C7eBD708Af50815fAa", symbol: "TBTC", decimals: 18 },
  27: { address: "0x056Fd409E1d7A124BD7017459dFEa2F387b6d5Cd", symbol: "GUSD", decimals: 2 },
  29: { address: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24", symbol: "RNDR", decimals: 18 },
  42: { address: "0x1494CA1F11D487c2bBe4543E90080AeBa4BA3C2b", symbol: "DPI", decimals: 18 },
  44: { address: "0x72e364F2ABdC788b7E918bc238B21f109Cd634D7", symbol: "MVI", decimals: 18 },
  61: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
  71: { address: "0xdA816459F1AB5631232FE5e97a05BBBb94970c95", symbol: "yvDAI", decimals: 18 },
  73: { address: "0xA696a63cc78DfFa1a63E9E50587C197387FF6C7E", symbol: "yvWBTC", decimals: 8 },
  74: { address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", symbol: "wstETH", decimals: 18 },
  76: { address: "0x607F4C5BB672230e8672085532f7e901544a7375", symbol: "RLC", decimals: 9 },
  79: { address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72", symbol: "ENS", decimals: 18 },
  82: { address: "0xa354F35829Ae975e850e23e9615b11Da1B3dC4DE", symbol: "yvUSDC", decimals: 6 },
  87: { address: "0xDB5C3C46E28B53a39C255AA39A411dD64e5fed9c", symbol: "NCR", decimals: 18 },
  92: { address: "0x853d955aCEf822Db058eb8505911ED77F175b99e", symbol: "FRAX", decimals: 18 },
  93: { address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", symbol: "SHIB", decimals: 18 },
  104: { address: "0x3845badAde8e6dFF049820680d1F14bD3903a5d0", symbol: "SAND", decimals: 18 },
  106: { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", symbol: "AAVE", decimals: 18 },
  132: { address: "0xae78736Cd615f374D3085123A210448E74Fc6393", symbol: "rETH", decimals: 18 },
  136: { address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", symbol: "LDO", decimals: 18 },
  145: { address: "0x92D6C1e31e14520e676a687F0a93788B716BEff5", symbol: "DYDX", decimals: 18 },
  146: { address: "0xD31a59c85aE9D8edEFeC411D448f90841571b89c", symbol: "SOL", decimals: 9 },
  148: { address: "0x85f138bfEE4ef8e540890CFb48F620571d67Eda3", symbol: "AVAX", decimals: 18 },
  149: { address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", symbol: "MATIC", decimals: 18 },
  156: { address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", symbol: "stETH", decimals: 18 },
  157: { address: "0x2aF1dF3AB0ab157e1E2Ad8F88A7D04fbea0c7dc6", symbol: "BED", decimals: 18 },
  167: { address: "0x7C07F7aBe10CE8e33DC6C5aD68FE033085256A84", symbol: "icETH", decimals: 18 },
};

/** One published file: leaves by (lowercase) address as [index, token id, amount], and the nodes their proofs need. */
export interface ZkSyncLiteShard {
  leaves?: Record<string, [number, number, string][]>;
  nodes?: string;
}

const abi = parseAbi([
  "function MERKLE_ROOT() view returns (bytes32)",
  "function isClaimed(uint256 index) view returns (bool)",
  "function claim(uint256 index, address token, uint256 amount, bytes32[] merkleProof)",
]);

/** Number of nodes on each level of the tree, leaves first; a lone last node moves up a level unchanged. */
const SIZES: number[] = [LEAVES];
while (SIZES[SIZES.length - 1] > 1) SIZES.push(Math.ceil(SIZES[SIZES.length - 1] / 2));

/** The (level, position) of each node in a leaf's proof, bottom up, as one number: level × 2^25 + position. */
function proofPositions(index: number): number[] {
  const out: number[] = [];
  for (let level = 0; level < SIZES.length - 1; level++) {
    const sibling = Math.floor(index / 2 ** level) ^ 1;
    if (sibling < SIZES[level]) out.push(level * 2 ** 25 + sibling);
  }
  return out;
}

const hashPair = (a: Hex, b: Hex) => keccak256(a.toLowerCase() <= b.toLowerCase() ? concat([a, b]) : concat([b, a]));
const leafHash = (index: number, claimant: Address, token: Address, amount: bigint) =>
  keccak256(concat([numberToHex(index, { size: 32 }), claimant, token, numberToHex(amount, { size: 32 })]));

/** Each of `user`'s leaves in a shard with its proof, checked against the root. Throws if the file doesn't add up. */
export function shardProofs(shard: ZkSyncLiteShard, user: Address): { index: number; token: number; amount: bigint; proof: Hex[] }[] {
  const mine = shard.leaves?.[user.toLowerCase()];
  if (!mine?.length) return [];
  // The file's nodes, in the order it was written: every position any of its leaves needs, by level then position.
  const positions = [...new Set(Object.values(shard.leaves!).flatMap((rows) => rows.flatMap(([index]) => proofPositions(index))))].sort((a, b) => a - b);
  const bytes = base64.decode(shard.nodes ?? "");
  if (bytes.length !== positions.length * 32) throw new Error("zkSync Lite list: the file is damaged");
  const node = new Map(positions.map((p, k) => [p, bytesToHex(bytes.subarray(32 * k, 32 * k + 32))]));
  return mine.map(([index, token, amount]) => {
    const t = ZKSYNC_LITE_TOKENS[token];
    if (!t) throw new Error(`zkSync Lite list: unknown token ${token}`);
    const proof = proofPositions(index).map((p) => node.get(p)!);
    const root = proof.reduce(hashPair, leafHash(index, user, t.address, BigInt(amount)));
    if (root !== ZKSYNC_LITE_ROOT) throw new Error("zkSync Lite list: a proof doesn't lead to the claim contract's root");
    return { index, token, amount: BigInt(amount), proof };
  });
}

async function loadShard(user: Address): Promise<ZkSyncLiteShard> {
  const res = await fetch(siteFile(`/legacy/zksync-lite/${user.slice(2, 4).toLowerCase()}.json`), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`zkSync Lite list: HTTP ${res.status}`);
  return (await res.json()) as ZkSyncLiteShard;
}

const assetOf = (token: number, amount: bigint): Asset => {
  const t = ZKSYNC_LITE_TOKENS[token];
  return token === 0 ? { symbol: "ETH", decimals: 18, amount } : { symbol: t.symbol, decimals: t.decimals, amount, token: t.address, tokenChain: "ethereum" };
};

export async function checkZkSyncLite(user: Address): Promise<CheckOutput> {
  const leaves = shardProofs(await loadShard(user), user);
  if (!leaves.length) return { findings: [], completed: 0 };
  const c = l1Client();
  // One multicall: the root (a new one would make the published proofs stale) and each leaf's claimed bit.
  const [root, ...claimed] = await Promise.all([
    c.readContract({ address: ZKSYNC_LITE_CLAIM, abi, functionName: "MERKLE_ROOT" }),
    ...leaves.map((l) => c.readContract({ address: ZKSYNC_LITE_CLAIM, abi, functionName: "isClaimed", args: [BigInt(l.index)] })),
  ]);
  if ((root as Hex).toLowerCase() !== ZKSYNC_LITE_ROOT) throw new Error("zkSync Lite: the claim contract has a new Merkle root, the list is out of date");
  const open = leaves.filter((_, i) => !claimed[i]);
  const paid = await Promise.all(
    open.map((l) =>
      dryRun(c, {
        from: user,
        to: ZKSYNC_LITE_CLAIM,
        data: encodeFunctionData({ abi, functionName: "claim", args: [BigInt(l.index), ZKSYNC_LITE_TOKENS[l.token].address, l.amount, l.proof] }),
      }),
    ),
  );
  const findings = open
    .filter((_, i) => paid[i] !== null)
    .map((l) => {
      const asset = assetOf(l.token, l.amount);
      return makeFinding(ZKSYNC_LITE, {
        key: String(l.index),
        label: `zkSync Lite balance (${asset.symbol})`,
        status: "ready",
        asset,
        txHash: ZKSYNC_LITE_CLAIM,
        txUrl: `https://etherscan.io/address/${ZKSYNC_LITE_CLAIM}#writeProxyContract`,
        linkLabel: "Open the claim contract",
        timestamp: SHUTDOWN,
        dateLabel: "Shut down",
        claimAt: "lite.zksync.io",
        minUsd: DUST_ETHEREUM,
        note: `zkSync Lite shut down on May 4, 2026 with ${formatAmount(l.amount, asset.decimals)} ${asset.symbol} in this address's account. It's waiting in the official claim contract on Ethereum, with no deadline: open lite.zksync.io with this wallet, which builds the proof and sends the claim (Matter Labs pays the gas of the first 100,000 claims). This is claim #${l.index} of the exit tree.`,
      });
    });
  return { findings, completed: leaves.length - open.length };
}
