import { encodeFunctionData, maxUint256, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * Aave's Safety Module: staking AAVE, its Balancer pool tokens or GHO earns AAVE that must be
 * claimed, and stays claimable after unstaking. One view per staking token (one multicall);
 * a reward is reported once claimRewards simulates from the user (the rewards vault's allowance
 * can run out, so the view alone isn't trusted).
 */

export const SAFETY_MODULE = rewardSource("aave-safety-module", "Aave Safety Module");

const AAVE: Address = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";

const MODULES: { key: string; name: string; staked: string; contract: Address }[] = [
  { key: "stkaave", name: "stkAAVE", staked: "AAVE", contract: "0x4da27a545c0c5B758a6BA100e3a049001de870f5" },
  { key: "stkabpt", name: "stkABPT", staked: "AAVE/ETH Balancer pool tokens", contract: "0xa1116930326D21fB917d5A27F1E9943A9595fb47" },
  { key: "stkaavewstethbptv2", name: "stkAAVEwstETHBPTv2", staked: "AAVE/wstETH Balancer pool tokens", contract: "0x9eDA81C21C273a82BE9Bbc19B6A6182212068101" },
  { key: "stkgho", name: "stkGHO", staked: "GHO", contract: "0x1a88Df1cFe15Af22B3c4c783D4e6F7F9e0C1885d" },
];

const abi = parseAbi(["function getTotalRewardsBalance(address staker) view returns (uint256)", "function claimRewards(address to, uint256 amount)"]);

export async function checkSafetyModule(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const balances = await Promise.all(
    MODULES.map((m) => c.readContract({ address: m.contract, abi, functionName: "getTotalRewardsBalance", args: [user] })),
  );
  const findings = await Promise.all(
    MODULES.map(async (m, i): Promise<Finding | null> => {
      const amount = balances[i];
      if (amount === 0n) return null;
      const data = encodeFunctionData({ abi, functionName: "claimRewards", args: [user, maxUint256] });
      if ((await dryRun(c, { from: user, to: m.contract, data })) === null) return null;
      return makeFinding(SAFETY_MODULE, {
        key: m.key,
        label: `Aave staking rewards (${m.name})`,
        status: "ready",
        asset: { symbol: "AAVE", decimals: 18, amount, token: AAVE, tokenChain: "ethereum" },
        txHash: m.contract,
        txUrl: `${ETHERSCAN}/address/${m.contract}`,
        timestamp: 0,
        claimAt: "app.aave.com (Staking)",
        minUsd: DUST_ETHEREUM,
        note: `Staking ${m.staked} in Aave's Safety Module (${m.name}) earned this address ${formatAmount(amount, 18)} AAVE that were never claimed. They stay claimable, even after unstaking.`,
      });
    }),
  );
  return { findings: findings.filter((f) => f !== null), completed: 0 };
}
