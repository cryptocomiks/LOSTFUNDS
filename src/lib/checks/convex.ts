import { encodeFunctionData, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * Convex's original staking pools, replaced by vlCVX and the cvxCRV staking wrapper but still
 * paying rewards that pile up until claimed:
 *  - CVX staking (cvxRewardPool): CRV earned, paid out as cvxCRV;
 *  - cvxCRV staking (the first BaseRewardPool): CRV, plus 3CRV and crvUSD from its extra pools.
 * Six views (one multicall); rewards are reported once getReward simulates from the user. The
 * staked tokens themselves aren't counted (the user can still see and withdraw them).
 */

export const CONVEX = rewardSource("convex-staking", "Convex staking");

const CVX_POOL: Address = "0xCF50b810E57Ac33B91dCF525C6ddd9881B139332";
const CVXCRV_POOL: Address = "0x3Fe65692bfCD0e6CF84cB1E7d24108E434A7587e";
/** cvxCRV pool's extra rewards (VirtualBalanceRewardPool): 3CRV, then crvUSD. */
const EXTRAS: { pool: Address; asset: Omit<Asset, "amount"> }[] = [
  { pool: "0x7091dbb7fcbA54569eF1387Ac89Eb2a5C9F6d2EA", asset: { symbol: "3CRV", decimals: 18, token: "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490", tokenChain: "ethereum" } },
  { pool: "0x191F455cc8acdd579f4E6956fC7007c9668C2289", asset: { symbol: "crvUSD", decimals: 18, token: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", tokenChain: "ethereum" } },
];
const CRV: Omit<Asset, "amount"> = { symbol: "CRV", decimals: 18, token: "0xD533a949740bb3306d119CC777fa900bA034cd52", tokenChain: "ethereum" };
const CVXCRV: Omit<Asset, "amount"> = { symbol: "cvxCRV", decimals: 18, token: "0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7", tokenChain: "ethereum" };

const abi = parseAbi([
  "function earned(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function getReward(address _account, bool _claimExtras, bool _stake)",
]);
const baseRewardPoolAbi = parseAbi(["function getReward(address _account, bool _claimExtras) returns (bool)"]);

export async function checkConvex(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const read = (address: Address, functionName: "earned" | "balanceOf") => c.readContract({ address, abi, functionName, args: [user] });
  const [cvxEarned, cvxStaked, crvEarned, cvxCrvStaked, ...extras] = await Promise.all([
    read(CVX_POOL, "earned"),
    read(CVX_POOL, "balanceOf"),
    read(CVXCRV_POOL, "earned"),
    read(CVXCRV_POOL, "balanceOf"),
    ...EXTRAS.map((x) => read(x.pool, "earned")),
  ]);

  const finding = (key: string, pool: Address, asset: Asset, note: string) =>
    makeFinding(CONVEX, {
      key,
      label: "Convex staking rewards",
      status: "ready",
      asset,
      txHash: pool,
      txUrl: `${ETHERSCAN}/address/${pool}#writeContract`,
      timestamp: 0,
      claimAt: "convexfinance.com",
      minUsd: DUST_ETHEREUM,
      note,
    });
  const stillStaked = (amount: bigint, symbol: string) =>
    amount > 0n ? ` You also still have ${formatAmount(amount, 18)} ${symbol} staked there, which you can withdraw at any time.` : "";

  const [cvxClaim, crvClaim] = await Promise.all([
    cvxEarned > 0n
      ? dryRun(c, { from: user, to: CVX_POOL, data: encodeFunctionData({ abi, functionName: "getReward", args: [user, true, false] }) })
      : null,
    crvEarned > 0n || extras.some((x) => x > 0n)
      ? dryRun(c, { from: user, to: CVXCRV_POOL, data: encodeFunctionData({ abi: baseRewardPoolAbi, functionName: "getReward", args: [user, true] }) })
      : null,
  ]);

  const findings: Finding[] = [];
  if (cvxClaim !== null)
    findings.push(
      finding("cvx-pool", CVX_POOL, { ...CVXCRV, amount: cvxEarned }, `Staking CVX in Convex's original CVX staking pool earned this address ${formatAmount(cvxEarned, 18)} CRV that were never claimed. They're paid out as cvxCRV.${stillStaked(cvxStaked, "CVX")}`),
    );
  if (crvClaim !== null) {
    const rewards = [{ asset: { ...CRV, amount: crvEarned } }, ...EXTRAS.map((x, i) => ({ asset: { ...x.asset, amount: extras[i] } }))].filter((r) => r.asset.amount > 0n);
    for (const r of rewards)
      findings.push(
        finding(`cvxcrv-pool-${r.asset.symbol.toLowerCase()}`, CVXCRV_POOL, r.asset, `Staking cvxCRV in Convex's original cvxCRV staking pool earned this address ${formatAmount(r.asset.amount, 18)} ${r.asset.symbol} that were never claimed.${stillStaked(cvxCrvStaked, "cvxCRV")}`),
      );
  }
  return { findings, completed: 0 };
}
