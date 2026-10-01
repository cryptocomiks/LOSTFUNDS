import { base64 } from "@scure/base";
import { bytesToHex, encodeFunctionData, getAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { l1Client } from "../clients";
import { formatAmount, formatDate } from "../format";
import { addPrices, ethAsset, tokenAsset } from "../tokens";
import type { Asset, Finding } from "../types";
import { DAY, makeFinding, now, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * EigenLayer, on Ethereum:
 *  - queued withdrawals: once the withdrawal delay (~14 days) is over, the staker must complete
 *    them; until then the tokens stay in EigenLayer. Listed by DelegationManager.getQueuedWithdrawals
 *    (withdrawals queued since the slashing upgrade of April 2025), reported as ready once
 *    completeQueuedWithdrawal simulates from the withdrawer, or as waiting until the delay is over.
 *  - rewards: what EigenLayer's sidecar API says can be claimed, checked against the
 *    RewardsCoordinator (cumulativeClaimed) and a simulated processClaim with its Merkle proof.
 *    The API is only asked about addresses that ever delegated to an operator. Besides EIGEN,
 *    tokens with no market price are left out (operators' own tokens, dust nearly every time).
 */

export const EIGEN_WITHDRAWALS = rewardSource("eigenlayer-withdrawals", "EigenLayer withdrawals");
export const EIGEN_REWARDS = rewardSource("eigenlayer-rewards", "EigenLayer rewards");

const DELEGATION_MANAGER: Address = "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A";
const REWARDS_COORDINATOR: Address = "0x7750d328b314EfFa365A0402CcfD489B80B0adda";
/** Native restaking: shares are wei of ETH, paid out of the staker's EigenPod. */
const BEACON_STRATEGY: Address = "0xbeaC0eeEeeeeEEeEeEEEEeeEEeEeeeEeeEEBEaC0";
const EIGEN: Address = "0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83";
/** What the EIGEN strategy holds and pays out: "backing EIGEN", which converts 1:1 into EIGEN. */
const BEIGEN: Address = "0x83E9115d334D248Ce39a6f36144aEaB5b3456e75";
const EIGEN_PRICE = `ethereum:${EIGEN.toLowerCase()}`;
const SIDECAR = "https://sidecar-rpc.eigenlayer.xyz/mainnet/rewards/v1";
const CLAIM_AT = "app.eigenlayer.xyz";
const BLOCK_TIME = 12;
const MAX_WITHDRAWALS = 20;

const delegationAbi = parseAbi([
  "struct Withdrawal { address staker; address delegatedTo; address withdrawer; uint256 nonce; uint32 startBlock; address[] strategies; uint256[] scaledShares; }",
  "function getQueuedWithdrawals(address staker) view returns (Withdrawal[] withdrawals, uint256[][] shares)",
  "function minWithdrawalDelayBlocks() view returns (uint32)",
  "function completeQueuedWithdrawal(Withdrawal withdrawal, address[] tokens, bool receiveAsTokens)",
  "function delegatedTo(address staker) view returns (address)",
  "function cumulativeWithdrawalsQueued(address staker) view returns (uint256)",
]);
const strategyAbi = parseAbi(["function underlyingToken() view returns (address)", "function sharesToUnderlyingView(uint256) view returns (uint256)"]);
const rewardsAbi = parseAbi([
  "struct EarnerTreeMerkleLeaf { address earner; bytes32 earnerTokenRoot; }",
  "struct TokenTreeMerkleLeaf { address token; uint256 cumulativeEarnings; }",
  "struct RewardsMerkleClaim { uint32 rootIndex; uint32 earnerIndex; bytes earnerTreeProof; EarnerTreeMerkleLeaf earnerLeaf; uint32[] tokenIndices; bytes[] tokenTreeProofs; TokenTreeMerkleLeaf[] tokenLeaves; }",
  "function processClaim(RewardsMerkleClaim claim, address recipient)",
  "function cumulativeClaimed(address earner, address token) view returns (uint256)",
  "function claimerFor(address earner) view returns (address)",
  "function getDistributionRootAtIndex(uint256 index) view returns ((bytes32 root, uint32 rewardsCalculationEndTimestamp, uint32 activatedAt, bool disabled))",
]);

/** EIGEN and bEIGEN are priced as EIGEN; other tokens by their own address. */
async function assetOf(c: PublicClient, token: Address, amount: bigint): Promise<Asset> {
  if (isAddressEqual(token, BEIGEN)) return { symbol: "bEIGEN", decimals: 18, amount, token, priceKey: EIGEN_PRICE };
  if (isAddressEqual(token, EIGEN)) return { symbol: "EIGEN", decimals: 18, amount, token, tokenChain: "ethereum" };
  return tokenAsset([c], token, amount, "ethereum");
}

/** What a strategy's shares are worth, and the token they're paid out in (any address for native ETH). */
async function underlying(c: PublicClient, strategy: Address, shares: bigint): Promise<{ token: Address; asset: Asset }> {
  if (isAddressEqual(strategy, BEACON_STRATEGY)) return { token: zeroAddress, asset: ethAsset(shares) };
  const [token, amount] = await Promise.all([
    c.readContract({ address: strategy, abi: strategyAbi, functionName: "underlyingToken" }),
    c.readContract({ address: strategy, abi: strategyAbi, functionName: "sharesToUnderlyingView", args: [shares] }),
  ]);
  return { token, asset: await assetOf(c, token, amount) };
}

const BEIGEN_NOTE = " It pays out bEIGEN, EigenLayer's backing token, which converts 1:1 into EIGEN.";

export async function checkEigenWithdrawals(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const [withdrawals, shares] = await c.readContract({ address: DELEGATION_MANAGER, abi: delegationAbi, functionName: "getQueuedWithdrawals", args: [user] });
  if (!withdrawals.length) return { findings: [], completed: 0 };
  const [delay, head] = await Promise.all([
    c.readContract({ address: DELEGATION_MANAGER, abi: delegationAbi, functionName: "minWithdrawalDelayBlocks" }),
    c.getBlockNumber(),
  ]);
  const days = Math.round((delay * BLOCK_TIME) / DAY);
  const findings: Finding[] = [];
  await Promise.all(
    withdrawals.slice(0, MAX_WITHDRAWALS).map(async (w, i) => {
      const parts = await Promise.all(w.strategies.map((s, j) => underlying(c, s, shares[i][j])));
      const queuedAt = Number((await c.getBlock({ blockNumber: BigInt(w.startBlock) })).timestamp);
      // Completable once the chain is past startBlock + delay.
      const lastBlock = BigInt(w.startBlock) + BigInt(delay);
      const ready = head > lastBlock;
      if (ready) {
        const data = encodeFunctionData({
          abi: delegationAbi,
          functionName: "completeQueuedWithdrawal",
          args: [w, parts.map((p) => p.token), true],
        });
        if ((await dryRun(c, { from: w.withdrawer, to: DELEGATION_MANAGER, data })) === null) return;
      }
      const readyAt = ready ? undefined : now() + Number(lastBlock + 1n - head) * BLOCK_TIME;
      const someoneElse = !isAddressEqual(w.withdrawer, user) ? ` Only ${w.withdrawer}, the withdrawer it names, can complete it.` : "";
      parts.forEach((p, j) => {
        const beigen = p.asset.symbol === "bEIGEN" ? BEIGEN_NOTE : "";
        findings.push(
          makeFinding(EIGEN_WITHDRAWALS, {
            key: `${w.nonce}:${j}`,
            label: "EigenLayer withdrawal",
            status: ready ? "ready" : "waiting",
            readyAt,
            asset: p.asset,
            txHash: `withdrawal-${w.nonce}`,
            txUrl: `${ETHERSCAN}/address/${DELEGATION_MANAGER}`,
            timestamp: queuedAt,
            dateLabel: "Queued",
            claimAt: CLAIM_AT,
            minUsd: DUST_ETHEREUM,
            note: ready
              ? `This withdrawal from EigenLayer was queued on ${formatDate(queuedAt)} and its ${days}-day wait is over, but nothing is sent until it's completed.${beigen}${someoneElse}`
              : `This withdrawal from EigenLayer was queued on ${formatDate(queuedAt)}. It can be completed after its ${days}-day wait, around ${formatDate(readyAt!)}. Nothing is sent automatically: complete it then.${beigen}${someoneElse}`,
          }),
        );
      });
    }),
  );
  return { findings, completed: 0 };
}

/* ───────────── Rewards ───────────── */

interface SidecarProof {
  rootIndex: number;
  earnerIndex: number;
  earnerTreeProof: string;
  earnerLeaf: { earner: string; earnerTokenRoot: string };
  tokenIndices: number[];
  tokenTreeProofs: string[];
  tokenLeaves: { token: string; cumulativeEarnings: string }[];
}

/** The sidecar encodes bytes as base64. */
const b64 = (s: string): Hex => bytesToHex(base64.decode(s));

async function sidecar<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${SIDECAR}/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`EigenLayer rewards API: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function checkEigenRewards(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  // Rewards go to operators and the stakers delegated to them: an address that never delegated has none.
  const [operator, queued] = await Promise.all([
    c.readContract({ address: DELEGATION_MANAGER, abi: delegationAbi, functionName: "delegatedTo", args: [user] }),
    c.readContract({ address: DELEGATION_MANAGER, abi: delegationAbi, functionName: "cumulativeWithdrawalsQueued", args: [user] }),
  ]);
  if (operator === zeroAddress && queued === 0n) return { findings: [], completed: 0 };

  const { rewards } = await sidecar<{ rewards?: { token: string; claimable: string }[] }>(`earners/${user}/summarized-rewards`);
  const tokens = (rewards ?? []).filter((r) => BigInt(r.claimable) > 0n).map((r) => getAddress(r.token));
  if (!tokens.length) return { findings: [], completed: 0 };
  const { proof: p } = await sidecar<{ proof?: SidecarProof }>("claim-proof", { earnerAddress: user, tokens });
  if (!p || !isAddressEqual(p.earnerLeaf.earner as Address, user)) throw new Error("EigenLayer rewards API: no proof for this address");

  const leaves = p.tokenLeaves.map((l) => ({ token: getAddress(l.token), cumulativeEarnings: BigInt(l.cumulativeEarnings) }));
  const [claimed, claimer, root] = await Promise.all([
    Promise.all(leaves.map((l) => c.readContract({ address: REWARDS_COORDINATOR, abi: rewardsAbi, functionName: "cumulativeClaimed", args: [user, l.token] }))),
    c.readContract({ address: REWARDS_COORDINATOR, abi: rewardsAbi, functionName: "claimerFor", args: [user] }),
    c.readContract({ address: REWARDS_COORDINATOR, abi: rewardsAbi, functionName: "getDistributionRootAtIndex", args: [BigInt(p.rootIndex)] }),
  ]);
  // What's left per token, on-chain (the API can lag behind recent claims).
  const open = leaves.map((l, i) => ({ i, amount: l.cumulativeEarnings - claimed[i] })).filter((x) => x.amount > 0n);
  if (!open.length) return { findings: [], completed: 0 };

  // A claim for some of the tokens: the proof's per-token parts, picked.
  const claimOf = (picked: number[]) => ({
    rootIndex: p.rootIndex,
    earnerIndex: p.earnerIndex,
    earnerTreeProof: b64(p.earnerTreeProof),
    earnerLeaf: { earner: user, earnerTokenRoot: b64(p.earnerLeaf.earnerTokenRoot) },
    tokenIndices: picked.map((i) => p.tokenIndices[i]),
    tokenTreeProofs: picked.map((i) => b64(p.tokenTreeProofs[i])),
    tokenLeaves: picked.map((i) => leaves[i]),
  });
  // Only the earner, or the claimer it set, may claim (always to an address of their choice).
  const from = claimer === zeroAddress ? user : claimer;
  const claims = (picked: number[]) =>
    dryRun(c, {
      from,
      to: REWARDS_COORDINATOR,
      data: encodeFunctionData({ abi: rewardsAbi, functionName: "processClaim", args: [claimOf(picked), user] }),
    });
  let ok = open;
  if ((await claims(open.map((x) => x.i))) === null) {
    // One token can make the whole claim fail: try each on its own.
    const each = await Promise.all(open.map((x) => claims([x.i])));
    ok = open.filter((_, k) => each[k] !== null);
  }

  const through = root.rewardsCalculationEndTimestamp;
  const viaClaimer = from !== user ? ` It must be claimed from ${from}, the claimer address this wallet set.` : "";
  const assets = await Promise.all(ok.map(({ i, amount }) => assetOf(c, leaves[i].token, amount)));
  // Operators' own tokens with no market price are dust nearly every time: only EIGEN is kept unpriced.
  const isEigen = (a: Asset) => a.token !== undefined && (isAddressEqual(a.token, EIGEN) || isAddressEqual(a.token, BEIGEN));
  await addPrices(assets.filter((a) => !isEigen(a)));
  const findings = ok.flatMap(({ i, amount }, k) => {
    const asset = assets[k];
    if (!isEigen(asset) && asset.usd === undefined) return [];
    return [
      makeFinding(EIGEN_REWARDS, {
        key: leaves[i].token,
        label: "EigenLayer rewards",
        status: "ready",
        asset,
        txHash: REWARDS_COORDINATOR,
        txUrl: `${ETHERSCAN}/address/${REWARDS_COORDINATOR}`,
        timestamp: through,
        dateLabel: "Earned through",
        claimAt: CLAIM_AT,
        minUsd: DUST_ETHEREUM,
        note: `Restaking on EigenLayer earned this address ${formatAmount(amount, asset.decimals)} ${asset.symbol} in rewards, counted until ${formatDate(through)}, that were never claimed. Rewards aren't sent automatically.${viaClaimer}`,
      }),
    ];
  });
  return { findings, completed: 0 };
}
