import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * ApeCoin's original staking contract on Ethereum. Its reward schedule ended (APE pool: November
 * 2024, BAYC / MAYC / BAKC pools: April 2025) when staking moved to ApeChain, but whatever was
 * staked stays there, earning nothing, until its owner withdraws it: 140+ million APE in
 * November 2026. getAllStakes lists the address's APE position and the stakes of the apes and
 * dogs it holds (one view); each amount is reported once its withdraw or claim simulates from
 * the address.
 */

export const APECOIN_STAKING = rewardSource("apecoin-staking", "ApeCoin staking");

const STAKING: Address = "0x5954aB967Bc958940b7EB73ee84797Dc8a2AFbb9";
const APE = (amount: bigint): Asset => ({ symbol: "APE", decimals: 18, amount, token: "0x4d224452801ACEd8B2F0aebE155379bb5D594381", tokenChain: "ethereum" });
const POOLS = ["APE", "BAYC", "MAYC", "BAKC"] as const;

const abi = parseAbi([
  "struct DashboardPair { uint256 mainTokenId; uint256 mainTypePoolId; }",
  "struct DashboardStake { uint256 poolId; uint256 tokenId; uint256 deposited; uint256 unclaimed; uint256 rewards24hr; DashboardPair pair; }",
  "struct SingleNft { uint32 tokenId; uint224 amount; }",
  "struct PairNft { uint128 mainTokenId; uint128 bakcTokenId; }",
  "struct PairNftWithdrawWithAmount { uint32 mainTokenId; uint32 bakcTokenId; uint184 amount; bool isUncommit; }",
  "function getAllStakes(address _address) view returns (DashboardStake[])",
  "function withdrawSelfApeCoin(uint256 _amount)",
  "function claimSelfApeCoin()",
  "function withdrawSelfBAYC(SingleNft[] _nfts)",
  "function withdrawSelfMAYC(SingleNft[] _nfts)",
  "function claimSelfBAYC(uint256[] _nfts)",
  "function claimSelfMAYC(uint256[] _nfts)",
  "function withdrawBAKC(PairNftWithdrawWithAmount[] _baycPairs, PairNftWithdrawWithAmount[] _maycPairs)",
  "function claimSelfBAKC(PairNft[] _baycPairs, PairNft[] _maycPairs)",
]);

type Stake = { poolId: bigint; tokenId: bigint; deposited: bigint; unclaimed: bigint; pair: { mainTokenId: bigint; mainTypePoolId: bigint } };

/** The withdraw and claim calls for one pool's stakes, sent by their owner. */
function calls(pool: number, stakes: Stake[]): { withdraw: Hex; claim: Hex } {
  const ids = stakes.map((s) => s.tokenId);
  if (pool === 0) return { withdraw: encodeFunctionData({ abi, functionName: "withdrawSelfApeCoin", args: [stakes[0].deposited] }), claim: encodeFunctionData({ abi, functionName: "claimSelfApeCoin" }) };
  if (pool === 1 || pool === 2) {
    const nfts = stakes.filter((s) => s.deposited > 0n).map((s) => ({ tokenId: Number(s.tokenId), amount: s.deposited }));
    return pool === 1
      ? { withdraw: encodeFunctionData({ abi, functionName: "withdrawSelfBAYC", args: [nfts] }), claim: encodeFunctionData({ abi, functionName: "claimSelfBAYC", args: [ids] }) }
      : { withdraw: encodeFunctionData({ abi, functionName: "withdrawSelfMAYC", args: [nfts] }), claim: encodeFunctionData({ abi, functionName: "claimSelfMAYC", args: [ids] }) };
  }
  // BAKC: each dog is paired with an ape (BAYC pool 1 or MAYC pool 2).
  const pairs = (main: bigint) => stakes.filter((s) => s.pair.mainTypePoolId === main);
  const withdrawPairs = (main: bigint) =>
    pairs(main).filter((s) => s.deposited > 0n).map((s) => ({ mainTokenId: Number(s.pair.mainTokenId), bakcTokenId: Number(s.tokenId), amount: s.deposited, isUncommit: true }));
  const claimPairs = (main: bigint) => pairs(main).map((s) => ({ mainTokenId: s.pair.mainTokenId, bakcTokenId: s.tokenId }));
  return {
    withdraw: encodeFunctionData({ abi, functionName: "withdrawBAKC", args: [withdrawPairs(1n), withdrawPairs(2n)] }),
    claim: encodeFunctionData({ abi, functionName: "claimSelfBAKC", args: [claimPairs(1n), claimPairs(2n)] }),
  };
}

export async function checkApeCoinStaking(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const stakes = (await c.readContract({ address: STAKING, abi, functionName: "getAllStakes", args: [user] })) as readonly Stake[];
  const findings: Finding[] = [];
  await Promise.all(
    POOLS.map(async (name, pool) => {
      const mine = stakes.filter((s) => Number(s.poolId) === pool && (s.deposited > 0n || s.unclaimed > 0n));
      if (!mine.length) return;
      const deposited = mine.reduce((n, s) => n + s.deposited, 0n);
      const unclaimed = mine.reduce((n, s) => n + s.unclaimed, 0n);
      const { withdraw, claim } = calls(pool, mine);
      const [withdrawOk, claimOk] = await Promise.all([
        deposited > 0n ? dryRun(c, { from: user, to: STAKING, data: withdraw }) : null,
        unclaimed > 0n ? dryRun(c, { from: user, to: STAKING, data: claim }) : null,
      ]);
      const nfts = pool === 0 ? "" : ` with ${mine.length > 1 ? `${mine.length} ${name}s` : `${name} #${mine[0].tokenId}`}`;
      const finding = (key: string, amount: bigint, note: string) =>
        makeFinding(APECOIN_STAKING, {
          key: `${name}:${key}`,
          label: `ApeCoin staking (${name} pool)`,
          status: "ready",
          asset: APE(amount),
          txHash: STAKING,
          txUrl: `${ETHERSCAN}/address/${STAKING}#writeContract`,
          linkLabel: "View contract",
          timestamp: 0,
          claimAt: pool === 0 ? "Etherscan (ApeCoinStaking → withdrawSelfApeCoin / claimSelfApeCoin)" : `Etherscan (ApeCoinStaking → withdraw / claim for ${name})`,
          minUsd: DUST_ETHEREUM,
          note,
        });
      if (withdrawOk !== null)
        findings.push(
          finding(
            "staked",
            deposited,
            `${formatAmount(deposited, 18)} APE are still staked${nfts} in ApeCoin's original staking contract. Its rewards ended in ${pool === 0 ? "November 2024" : "April 2025"}, when staking moved to ApeChain: this APE earns nothing until you withdraw it.`,
          ),
        );
      if (claimOk !== null)
        findings.push(finding("rewards", unclaimed, `Staking APE${nfts} earned ${formatAmount(unclaimed, 18)} APE of rewards that were never claimed. They stay claimable.`));
    }),
  );
  return { findings, completed: 0 };
}
