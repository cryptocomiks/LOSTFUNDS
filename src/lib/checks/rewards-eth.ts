import type { Address } from "viem";
import type { CheckSource } from "../sources";
import type { CheckOutput, FindingSource } from "./common";
import { CONVEX, checkConvex } from "./convex";
import { checkEigenRewards, checkEigenWithdrawals, EIGEN_REWARDS, EIGEN_WITHDRAWALS } from "./eigenlayer";
import { BALANCER_FEES, checkBalancerFees, checkCurveFees, CURVE_FEES } from "./feedistributors";
import { checkLido, LIDO } from "./lido";
import { checkLocks, LOCKS } from "./locks";
import { checkSafetyModule, SAFETY_MODULE } from "./safetymodule";
import { checkSynthetixEscrow, SNX_ESCROW } from "./synthetix";

/**
 * "Unclaimed rewards & withdrawals" on Ethereum (and OP Mainnet for Synthetix): money a protocol
 * holds for the user until they claim it. Each check costs a view or two in the shared multicall
 * for an address with nothing there; claims are only simulated when a view finds something.
 */

const source = (src: FindingSource, bridgeUrl: string, run: (user: Address) => Promise<CheckOutput>): CheckSource => ({
  id: src.id,
  name: src.name,
  group: "rewards",
  bridgeUrl,
  accepts: ["evm"],
  run: (user) => run(user as Address),
});

export const ETH_REWARD_SOURCES: CheckSource[] = [
  source(LIDO, "stake.lido.fi/withdrawals/claim", checkLido),
  source(LOCKS, "the protocol's own app", checkLocks),
  source(CURVE_FEES, "curve.finance (DAO page)", checkCurveFees),
  source(EIGEN_WITHDRAWALS, "app.eigenlayer.xyz", checkEigenWithdrawals),
  source(EIGEN_REWARDS, "app.eigenlayer.xyz", checkEigenRewards),
  source(SAFETY_MODULE, "app.aave.com (Staking)", checkSafetyModule),
  source(SNX_ESCROW, "etherscan.io (RewardEscrowV2 → vest)", checkSynthetixEscrow),
  source(CONVEX, "convexfinance.com", checkConvex),
  source(BALANCER_FEES, "balancer.fi (veBAL)", checkBalancerFees),
];
